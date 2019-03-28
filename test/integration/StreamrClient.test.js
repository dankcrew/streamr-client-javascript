import assert from 'assert'
import fetch from 'node-fetch'
import { MessageLayer } from 'streamr-client-protocol'
import { ethers } from 'ethers'
import uniqueId from 'lodash/uniqueId'
import StreamrClient from '../../src'
import config from './config'

const { StreamMessage } = MessageLayer

describe('StreamrClient', () => {
    let client
    let stream

    // These tests will take time, especially on Travis
    jest.setTimeout(15 * 1000)

    const createClient = (opts = {}) => new StreamrClient({
        url: config.websocketUrl,
        restUrl: config.restUrl,
        auth: {
            privateKey: ethers.Wallet.createRandom().privateKey,
        },
        autoConnect: false,
        autoDisconnect: false,
        ...opts,
    })

    const createStream = async () => {
        const name = `StreamrClient-integration-${Date.now()}`
        assert(client.isConnected())

        const s = await client.createStream({
            name,
            requireSignedData: true,
        })

        assert(s.id)
        assert.equal(s.name, name)
        assert.strictEqual(s.requireSignedData, true)
        return s
    }

    const ensureConnected = () => new Promise((resolve) => {
        client.on('connected', resolve)
        client.connect()
    })

    beforeEach(async () => {
        try {
            await Promise.all([
                fetch(config.restUrl),
                fetch(config.websocketUrl.replace('ws://', 'http://')),
            ])
        } catch (e) {
            if (e.errno === 'ENOTFOUND' || e.errno === 'ECONNREFUSED') {
                throw new Error('Integration testing requires that engine-and-editor ' +
                    'and data-api ("entire stack") are running in the background. ' +
                    'Instructions: https://github.com/streamr-dev/streamr-docker-dev#running')
            } else {
                throw e
            }
        }

        client = createClient()
        await ensureConnected()
        stream = await createStream()
    })

    afterEach(() => {
        if (client && client.isConnected()) {
            return client.disconnect()
        }
        return Promise.resolve()
    })

    describe('Pub/Sub', () => {
        it('client.publish', () => client.publish(stream.id, {
            test: 'client.publish',
        }))

        it('Stream.publish', () => stream.publish({
            test: 'Stream.publish',
        }))

        it('client.publish with Stream object as arg', () => {
            client.publish(stream, {
                test: 'client.publish.Stream.object',
            })
        })

        it('client.subscribe with resend from', (done) => {
            // Publish message
            client.publish(stream.id, {
                test: 'client.subscribe with resend',
            })

            // Check that we're not subscribed yet
            assert.strictEqual(client.subscribedStreams[stream.id], undefined)

            // Add delay: this test needs some time to allow the message to be written to Cassandra
            setTimeout(() => {
                const sub = client.subscribe({
                    stream: stream.id,
                    resend: {
                        from: {
                            timestamp: 0,
                        },
                    },
                }, async (parsedContent, streamMessage) => {
                    // Check message content
                    assert.strictEqual(parsedContent.test, 'client.subscribe with resend')

                    // Check signature stuff
                    const subStream = client.subscribedStreams[stream.id]
                    const publishers = await subStream.getPublishers()
                    const requireVerification = await subStream.getVerifySignatures()
                    assert.strictEqual(requireVerification, true)
                    assert.deepStrictEqual(publishers, [client.signer.address.toLowerCase()])
                    assert.strictEqual(streamMessage.signatureType, StreamMessage.SIGNATURE_TYPES.ETH)
                    assert(streamMessage.getPublisherId())
                    assert(streamMessage.signature)

                    // All good, unsubscribe
                    client.unsubscribe(sub)
                    sub.on('unsubscribed', () => {
                        assert.strictEqual(client.subscribedStreams[stream.id], undefined)
                        done()
                    })
                })
            }, 10000)
        })

        it('client.subscribe with resend last', (done) => {
            // Publish message
            client.publish(stream.id, {
                test: 'client.subscribe with resend',
            })

            // Check that we're not subscribed yet
            assert.strictEqual(client.subscribedStreams[stream.id], undefined)

            // Add delay: this test needs some time to allow the message to be written to Cassandra
            setTimeout(() => {
                const sub = client.subscribe({
                    stream: stream.id,
                    resend: {
                        last: 1,
                    },
                }, async (parsedContent, streamMessage) => {
                    // Check message content
                    assert.strictEqual(parsedContent.test, 'client.subscribe with resend')

                    // Check signature stuff
                    const subStream = client.subscribedStreams[stream.id]
                    const publishers = await subStream.getPublishers()
                    const requireVerification = await subStream.getVerifySignatures()
                    assert.strictEqual(requireVerification, true)
                    assert.deepStrictEqual(publishers, [client.signer.address.toLowerCase()])
                    assert.strictEqual(streamMessage.signatureType, StreamMessage.SIGNATURE_TYPES.ETH)
                    assert(streamMessage.getPublisherId())
                    assert(streamMessage.signature)

                    // All good, unsubscribe
                    client.unsubscribe(sub)
                    sub.on('unsubscribed', () => {
                        assert.strictEqual(client.subscribedStreams[stream.id], undefined)
                        done()
                    })
                })
            }, 10000)
        })

        it.only('client.subscribe with resend last 2', async (done) => {
            const stream2 = await client.createStream({
                name: uniqueId(),
            })
            const message1 = {
                test: 'message1',
            }
            const message2 = {
                test: 'message2',
            }
            const message3 = {
                test: 'message3',
            }
            // Publish message
            await stream2.publish(message1)
            await stream2.publish(message2)

            const messages = []
            const expectedMessages = [message2, message3]
            setTimeout(async () => {
                await stream2.publish(message3)
                const sub = client.subscribe({
                    stream: stream2.id,
                    resend: {
                        last: 2,
                    },
                }, (parsedContent) => {
                    console.log(parsedContent)
                    messages.push(parsedContent)
                    if (messages.length === 2) {
                        // wait a moment to make sure more messages don't arrive
                        setTimeout(() => {
                            sub.once('unsubscribed', () => {
                                expect(messages).toEqual(expectedMessages)
                                done()
                            })
                            client.unsubscribe(sub)
                        }, 1000)
                    }
                })
            }, 1000)
        }, 20000)

        it('client.subscribe (realtime)', (done) => {
            const id = Date.now()
            const sub = client.subscribe({
                stream: stream.id,
            }, (parsedContent, streamMessage) => {
                assert.equal(parsedContent.id, id)

                // Check signature stuff
                assert.strictEqual(streamMessage.signatureType, StreamMessage.SIGNATURE_TYPES.ETH)
                assert(streamMessage.getPublisherId())
                assert(streamMessage.signature)

                // All good, unsubscribe
                client.unsubscribe(sub)
                sub.on('unsubscribed', () => {
                    done()
                })
            })

            // Publish after subscribed
            sub.on('subscribed', () => {
                stream.publish({
                    id,
                })
            })
        })
    })
})
