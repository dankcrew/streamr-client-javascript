import crypto from 'crypto'

import Receptacle from 'receptacle'
import randomstring from 'randomstring'
import { MessageLayer } from 'streamr-client-protocol'
import { ethers } from 'ethers'

import Stream from './rest/domain/Stream'
import InvalidMessageTypeError from './errors/InvalidMessageTypeError'

const { StreamMessage, MessageID, MessageRef } = MessageLayer

export default class MessageCreationUtil {
    constructor(auth, signer, getUserInfo, getStreamFunction) {
        this.auth = auth
        this._signer = signer
        this.getUserInfo = getUserInfo
        this.getStreamFunction = getStreamFunction
        this.cachedStreams = new Receptacle({
            max: 10000,
        })
        this.publishedStreams = {}
        this.msgChainId = randomstring.generate(20)
        this.cachedHashes = {}
    }

    stop() {
        this.cachedStreams.clear()
    }

    async getUsername() {
        if (!this.usernamePromise) {
            // In the edge case where StreamrClient.auth.apiKey is an anonymous key, userInfo.id is that anonymous key
            this.usernamePromise = this.getUserInfo().then((userInfo) => userInfo.username || userInfo.id)
        }
        return this.usernamePromise
    }

    async getStream(streamId) {
        if (!this.cachedStreams.get(streamId)) {
            const streamPromise = this.getStreamFunction(streamId).then((stream) => ({
                id: stream.id,
                partitions: stream.partitions,
            }))
            const success = this.cachedStreams.set(streamId, streamPromise, {
                ttl: 30 * 60 * 1000, // 30 minutes
                refresh: true, // reset ttl on access
            })
            if (!success) {
                console.warn(`Could not store stream with id ${streamId} in local cache.`)
                return streamPromise
            }
        }
        return this.cachedStreams.get(streamId)
    }

    async getPublisherId() {
        if (!this.publisherId) {
            if (this.auth.privateKey !== undefined) {
                this.publisherId = ethers.utils.computeAddress(this.auth.privateKey).toLowerCase()
            } else if (this.auth.provider !== undefined) {
                const provider = new ethers.providers.Web3Provider(this.auth.provider)
                this.publisherId = provider.getSigner().address.toLowerCase()
            } else if (this.auth.apiKey !== undefined) {
                const hexString = ethers.utils.hexlify(Buffer.from(await this.getUsername(), 'utf8'))
                this.publisherId = ethers.utils.sha256(hexString)
            } else if (this.auth.username !== undefined) {
                const hexString = ethers.utils.hexlify(Buffer.from(this.auth.username, 'utf8'))
                this.publisherId = ethers.utils.sha256(hexString)
            } else if (this.auth.sessionToken !== undefined) {
                const hexString = ethers.utils.hexlify(Buffer.from(await this.getUsername(), 'utf8'))
                this.publisherId = ethers.utils.sha256(hexString)
            } else {
                throw new Error('Need either "privateKey", "provider", "apiKey", "username"+"password" or "sessionToken" to derive the publisher Id.')
            }
        }
        return this.publisherId
    }

    getNextSequenceNumber(key, timestamp) {
        if (timestamp !== this.getPrevTimestamp(key)) {
            return 0
        }
        return this.getPrevSequenceNumber(key) + 1
    }

    getPrevMsgRef(key) {
        const prevTimestamp = this.getPrevTimestamp(key)
        if (!prevTimestamp) {
            return null
        }
        const prevSequenceNumber = this.getPrevSequenceNumber(key)
        return new MessageRef(prevTimestamp, prevSequenceNumber)
    }

    getPrevTimestamp(key) {
        return this.publishedStreams[key].prevTimestamp
    }

    getPrevSequenceNumber(key) {
        return this.publishedStreams[key].prevSequenceNumber
    }

    async createStreamMessage(streamObjectOrId, data, timestamp = Date.now(), partitionKey = null) {
        // Validate data
        if (typeof data !== 'object') {
            throw new Error(`Message data must be an object! Was: ${data}`)
        }

        const stream = (streamObjectOrId instanceof Stream) ? streamObjectOrId : await this.getStream(streamObjectOrId)
        const streamPartition = this.computeStreamPartition(stream.partitions, partitionKey)
        const publisherId = await this.getPublisherId()
        const [messageId, prevMsgRef] = this.createMsgIdAndPrevRef(stream.id, streamPartition, timestamp, publisherId)

        const streamMessage = new StreamMessage({
            messageId,
            prevMsgRef,
            content: data,
            messageType: StreamMessage.CONTENT_TYPES.MESSAGE,
        })

        if (this._signer) {
            await this._signer.signStreamMessage(streamMessage)
        }
        return streamMessage
    }

    createMsgIdAndPrevRef(streamId, streamPartition, timestamp, publisherId) {
        const key = streamId + streamPartition
        if (!this.publishedStreams[key]) {
            this.publishedStreams[key] = {
                prevTimestamp: null,
                prevSequenceNumber: 0,
            }
        }

        const sequenceNumber = this.getNextSequenceNumber(key, timestamp)
        const messageId = new MessageID(streamId, streamPartition, timestamp, sequenceNumber, publisherId, this.msgChainId)
        const prevMsgRef = this.getPrevMsgRef(key)
        this.publishedStreams[key].prevTimestamp = timestamp
        this.publishedStreams[key].prevSequenceNumber = sequenceNumber
        return [messageId, prevMsgRef]
    }

    createDefaultMsgIdAndPrevRef(streamId, publisherId) {
        return this.createMsgIdAndPrevRef(streamId, 0, Date.now(), publisherId)
    }

    static getErrorCodeFromError(error) {
        if (error instanceof InvalidMessageTypeError) {
            return 'INVALID_MESSAGE_TYPE'
        }
        return 'UNEXPECTED_ERROR'
    }

    hash(stringToHash) {
        if (this.cachedHashes[stringToHash] === undefined) {
            this.cachedHashes[stringToHash] = crypto.createHash('md5').update(stringToHash).digest()
        }
        return this.cachedHashes[stringToHash]
    }

    computeStreamPartition(partitionCount, partitionKey) {
        if (!partitionCount) {
            throw new Error('partitionCount is falsey!')
        } else if (partitionCount === 1) {
            // Fast common case
            return 0
        } else if (partitionKey) {
            const buffer = this.hash(partitionKey)
            const intHash = buffer.readInt32LE()
            return Math.abs(intHash) % partitionCount
        } else {
            // Fallback to random partition if no key
            return Math.floor(Math.random() * partitionCount)
        }
    }
}
