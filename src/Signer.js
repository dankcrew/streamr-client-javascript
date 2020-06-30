import { MessageLayer, Utils } from 'streamr-client-protocol'
import { ethers } from 'ethers'

const { StreamMessage } = MessageLayer
const { SigningUtil } = Utils
const { SIGNATURE_TYPES } = StreamMessage

const debug = require('debug')('StreamrClient::Signer')

export default class Signer {
    constructor(options = {}) {
        // copy options to prevent possible later mutation
        this.options = {
            ...options,
        }
        const { privateKey, provider } = this.options
        if (privateKey) {
            this.address = ethers.utils.computeAddress(privateKey)
            const key = (typeof privateKey === 'string' && privateKey.startsWith('0x'))
                ? privateKey.slice(2) // strip leading 0x
                : privateKey
            this.sign = async (d) => {
                return SigningUtil.sign(d, key)
            }
        } else if (provider) {
            const web3Provider = new ethers.providers.Web3Provider(provider)
            const signer = web3Provider.getSigner()
            this.address = signer.address
            this.sign = async (d) => signer.signMessage(d)
        } else {
            throw new Error('Need either "privateKey" or "provider".')
        }
    }

    async signData(data, signatureType = SIGNATURE_TYPES.ETH) {
        if (signatureType === SIGNATURE_TYPES.ETH_LEGACY || signatureType === SIGNATURE_TYPES.ETH) {
            return this.sign(data)
        }
        throw new Error(`Unrecognized signature type: ${signatureType}`)
    }

    async signStreamMessage(streamMessage, signatureType = SIGNATURE_TYPES.ETH) {
        if (!streamMessage.getTimestamp()) {
            throw new Error('Timestamp is required as part of the data to sign.')
        }
        /* eslint-disable no-param-reassign */
        // set signature & publisher so getting of payload works correctly
        streamMessage.signatureType = signatureType
        streamMessage.messageId.publisherId = this.address // changing the id seems bad
        const payload = streamMessage.getPayloadToSign()
        streamMessage.signature = await this.signData(payload, signatureType)
        /* eslint-enable no-param-reassign */
    }

    static async verifyStreamMessage(msg) {
        const result = await SigningUtil.verify(msg.getPublisherId(), msg.getPayloadToSign(), msg.signature)
        debug('verifyStreamMessage: pass: %o, message: %o', result, msg)
        return result
    }

    static createSigner(options, publishWithSignature) {
        if (publishWithSignature === 'never') {
            return undefined
        }

        if (publishWithSignature === 'auto' && !options.privateKey && !options.provider) {
            return undefined
        }

        if (publishWithSignature === 'auto' || publishWithSignature === 'always') {
            return new Signer(options)
        }
        throw new Error(`Unknown parameter value: ${publishWithSignature}`)
    }
}
