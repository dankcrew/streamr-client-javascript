import Emitter from 'events'

import sinon from 'sinon'
import Debug from 'debug'
import { wait } from 'streamr-test-utils'
import express from 'express'

import authFetch from '../../src/rest/authFetch'
import { uuid, pUpDownSteps, Defer } from '../../src/utils'

const debug = Debug('StreamrClient::test::utils')

describe('utils', () => {
    let session
    let expressApp
    let server
    const baseUrl = 'http://127.0.0.1:30000'
    const testUrl = '/some-test-url'

    beforeAll((done) => {
        session = sinon.stub()
        session.options = {}
        expressApp = express()

        function handle(req, res) {
            if (req.get('Authorization') !== 'Bearer session-token') {
                res.sendStatus(401)
            } else {
                res.status(200).send({
                    test: 'test',
                })
            }
        }

        expressApp.get(testUrl, (req, res) => handle(req, res))

        server = expressApp.listen(30000, () => {
            debug('Mock server started on port 30000\n') // eslint-disable-line no-console
            done()
        })
    })

    afterAll((done) => {
        server.close(done)
    })

    describe('authFetch', () => {
        it('should return normally when valid session token is passed', async () => {
            session.getSessionToken = sinon.stub().resolves('session-token')
            const res = await authFetch(baseUrl + testUrl, session)
            expect(session.getSessionToken.calledOnce).toBeTruthy()
            expect(res.test).toBeTruthy()
        })

        it('should return 401 error when invalid session token is passed twice', async () => {
            session.getSessionToken = sinon.stub().resolves('invalid token')
            const onCaught = jest.fn()
            await authFetch(baseUrl + testUrl, session).catch((err) => {
                onCaught()
                expect(session.getSessionToken.calledTwice).toBeTruthy()
                expect(err.toString()).toMatch(
                    `${baseUrl + testUrl} returned with error code 401. Unauthorized`
                )
                expect(err.body).toEqual('Unauthorized')
            })
            expect(onCaught).toHaveBeenCalledTimes(1)
        })

        it('should return normally when valid session token is passed after expired session token', async () => {
            session.getSessionToken = sinon.stub()
            session.getSessionToken.onCall(0).resolves('expired-session-token')
            session.getSessionToken.onCall(1).resolves('session-token')

            const res = await authFetch(baseUrl + testUrl, session)
            expect(session.getSessionToken.calledTwice).toBeTruthy()
            expect(res.test).toBeTruthy()
        })
    })

    describe('uuid', () => {
        it('generates different ids', () => {
            expect(uuid('test')).not.toEqual(uuid('test'))
        })
        it('includes text', () => {
            expect(uuid('test')).toContain('test')
        })
        it('increments', () => {
            const uid = uuid('test') // generate new text to ensure count starts at 1
            expect(uuid(uid) < uuid(uid)).toBeTruthy()
        })
    })

    describe('pUpDownSteps', () => {
        let order
        let up
        let down
        let emitter

        beforeEach(() => {
            if (emitter) {
                emitter.removeAllListeners()
            }

            order = []
            const currentOrder = order
            emitter = new Emitter()

            emitter.on('next', (name, v = '') => {
                currentOrder.push(`${name} ${v}`.trim())
            })

            const currentEmitter = emitter
            up = async (...args) => {
                currentEmitter.emit('next', 'up start', ...args)
                await wait(50)
                currentEmitter.emit('next', 'up end', ...args)
            }

            down = async (...args) => {
                currentEmitter.emit('next', 'down start', ...args)
                await wait(10)
                currentEmitter.emit('next', 'down end', ...args)
            }
        })

        it('calls up/down only once', async () => {
            let shouldUp = true
            const next = pUpDownSteps([
                async () => {
                    await up()
                    return () => down()
                }
            ], () => shouldUp)

            await Promise.all([
                next(),
                next()
            ])

            shouldUp = false

            await Promise.all([
                next(),
                next()
            ])

            expect(order).toEqual([
                'up start',
                'up end',
                'down start',
                'down end',
            ])
        })

        it('calls down automatically if check is false after up complete', async () => {
            let shouldUp = true
            const next = pUpDownSteps([
                async () => {
                    await up()
                    shouldUp = false
                    return () => down()
                }
            ], () => shouldUp)

            await next()

            expect(order).toEqual([
                'up start',
                'up end',
                'down start',
                'down end',
            ])
        })

        it('does nothing if check fails', async () => {
            const shouldUp = false
            const next = pUpDownSteps([
                async () => {
                    await up()
                    return () => down()
                }
            ], () => shouldUp)

            await next()

            expect(order).toEqual([])
        })

        it('only calls one at a time when down called during up', async () => {
            let shouldUp = true

            const next = pUpDownSteps([
                async () => {
                    await up()
                    return () => down()
                }
            ], () => shouldUp)
            const done = Defer()
            emitter.on('next', async (name) => {
                if (name === 'up start') {
                    shouldUp = false
                    await next()
                    expect(order).toEqual([
                        'up start',
                        'up end',
                        'down start',
                        'down end',
                    ])
                    done.resolve()
                }
            })

            await next()

            expect(order).toEqual([
                'up start',
                'up end',
                'down start',
                'down end',
            ])

            await done
        })

        describe('plays undo stack at point of state change', () => {
            let shouldUp
            let next
            beforeEach(() => {
                shouldUp = false

                next = pUpDownSteps([
                    async () => {
                        await up('a')
                        return () => down('a')
                    },
                    async () => {
                        await up('b')
                        return () => down('b')
                    },
                    async () => {
                        await up('c')
                        return () => down('c')
                    },
                ], () => shouldUp)
            })

            it('plays all up steps in order, then down steps in order', async () => {
                shouldUp = true
                await next()
                expect(order).toEqual([
                    'up start a',
                    'up end a',
                    'up start b',
                    'up end b',
                    'up start c',
                    'up end c',
                ])
                shouldUp = false
                await next()
                expect(order).toEqual([
                    'up start a',
                    'up end a',
                    'up start b',
                    'up end b',
                    'up start c',
                    'up end c',
                    'down start c',
                    'down end c',
                    'down start b',
                    'down end b',
                    'down start a',
                    'down end a',
                ])
            })

            it('can stop before first step', async () => {
                shouldUp = true
                const done = Defer()
                emitter.on('next', async (name, v) => {
                    if (name === 'up start' && v === 'a') {
                        shouldUp = false
                        done.resolve()
                    }
                })

                await next()
                expect(order).toEqual([
                    'up start a',
                    'up end a',
                    'down start a',
                    'down end a',
                ])
                await done
            })

            it('can stop before second step', async () => {
                shouldUp = true
                const done = Defer()
                emitter.on('next', async (name, v) => {
                    if (name === 'up end' && v === 'b') {
                        shouldUp = false
                        done.resolve()
                    }
                })

                await next()
                expect(order).toEqual([
                    'up start a',
                    'up end a',
                    'up start b',
                    'up end b',
                    'down start b',
                    'down end b',
                    'down start a',
                    'down end a',
                ])
                await done
            })
        })
    })
})
