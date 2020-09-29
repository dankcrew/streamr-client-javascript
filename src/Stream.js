import { PassThrough } from 'stream'

import pMemoize from 'p-memoize'
import pLimit from 'p-limit'
import { ControlLayer, MessageLayer } from 'streamr-client-protocol'
import AbortController from 'node-abort-controller'

import { uuid } from './utils'

const {
    SubscribeRequest, UnsubscribeRequest, ControlMessage,
    ResendLastRequest, ResendFromRequest, ResendRangeRequest,
} = ControlLayer

const { MessageRef } = MessageLayer

export class AbortError extends Error {
    constructor(msg = '', ...args) {
        super(`The operation was aborted. ${msg}`, ...args)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor)
        }
    }
}

function validateOptions(optionsOrStreamId) {
    if (!optionsOrStreamId) {
        throw new Error('options is required!')
    }

    // Backwards compatibility for giving a streamId as first argument
    let options
    if (typeof optionsOrStreamId === 'string') {
        options = {
            streamId: optionsOrStreamId,
            streamPartition: 0,
        }
    } else if (typeof optionsOrStreamId === 'object') {
        // shallow copy
        options = {
            streamPartition: 0,
            ...optionsOrStreamId
        }
    } else {
        throw new Error(`options must be an object! Given: ${optionsOrStreamId}`)
    }

    if (!options.streamId) {
        throw new Error(`streamId must be set, given: ${optionsOrStreamId}`)
    }

    return options
}

const ResendResponses = [ControlMessage.TYPES.ResendResponseResending, ControlMessage.TYPES.ResendResponseNoResend]

const PAIRS = new Map([
    [ControlMessage.TYPES.SubscribeRequest, [ControlMessage.TYPES.SubscribeResponse]],
    [ControlMessage.TYPES.UnsubscribeRequest, [ControlMessage.TYPES.UnsubscribeResponse]],
    [ControlMessage.TYPES.ResendLastRequest, ResendResponses],
    [ControlMessage.TYPES.ResendFromRequest, ResendResponses],
    [ControlMessage.TYPES.ResendRangeRequest, ResendResponses],
])

async function waitForResponse({ connection, types, requestId }) {
    return new Promise((resolve, reject) => {
        let cleanup
        const onResponse = (res) => {
            if (res.requestId !== requestId) { return }
            // clean up err handler
            cleanup()
            resolve(res)
        }

        const onErrorResponse = (res) => {
            if (res.requestId !== requestId) { return }
            // clean up success handler
            cleanup()
            const error = new Error(res.errorMessage)
            error.code = res.errorCode
            reject(error)
        }

        cleanup = () => {
            types.forEach((type) => {
                connection.off(type, onResponse)
            })
            connection.off(ControlMessage.TYPES.ErrorResponse, onErrorResponse)
        }

        types.forEach((type) => {
            connection.on(type, onResponse)
        })
        connection.on(ControlMessage.TYPES.ErrorResponse, onErrorResponse)
    })
}

async function waitForRequestResponse(client, request) {
    return waitForResponse({
        connection: client.connection,
        types: PAIRS.get(request.type),
        requestId: request.requestId,
    })
}

function getIsMatchingStreamMessage({ streamId, streamPartition = 0 }) {
    return function isMatchingStreamMessage({ streamMessage }) {
        const msgStreamId = streamMessage.getStreamId()
        if (streamId !== msgStreamId) { return false }
        const msgPartition = streamMessage.getStreamPartition()
        if (streamPartition !== msgPartition) { return false }
        return true
    }
}

async function subscribe(client, { streamId, streamPartition = 0 }) {
    const sessionToken = await client.session.getSessionToken()
    const request = new SubscribeRequest({
        streamId,
        streamPartition,
        sessionToken,
        requestId: uuid('sub'),
    })

    const onResponse = waitForRequestResponse(client, request)

    await client.send(request)
    return onResponse
}

async function unsubscribe(client, { streamId, streamPartition = 0 }) {
    const sessionToken = await client.session.getSessionToken()
    const request = new UnsubscribeRequest({
        streamId,
        streamPartition,
        sessionToken,
        requestId: uuid('unsub'),
    })

    const onResponse = waitForRequestResponse(client, request)

    await client.send(request)
    return onResponse
}

/**
 * Allows injecting a function to execute after an iterator finishes.
 * Executes finally function even if generator not started.
 */

function iteratorFinally(iterator, onFinally = () => {}) {
    let started = false
    const g = (async function* It() {
        started = true
        try {
            yield* iterator
        } finally {
            await onFinally(iterator)
        }
    }())

    // overrides return/throw to call onFinally even if generator was never started
    const oldReturn = g.return
    g.return = async (...args) => {
        if (!started) {
            await onFinally(iterator)
        }
        return oldReturn.call(g, ...args)
    }
    const oldThrow = g.throw
    g.throw = async (...args) => {
        if (!started) {
            await onFinally(iterator)
        }
        return oldThrow.call(g, ...args)
    }
    return g
}

function messageStream(client, { streamId, streamPartition, signal, type = ControlMessage.TYPES.BroadcastMessage }) {
    if (signal && signal.aborted) {
        throw new AbortError()
    }

    const queue = new PassThrough({
        objectMode: true,
    })

    const onAbort = () => {
        return queue.destroy(new AbortError())
    }

    if (signal) {
        signal.addEventListener('abort', onAbort, {
            once: true
        })
    }

    const isMatchingStreamMessage = getIsMatchingStreamMessage({
        streamId,
        streamPartition
    })

    const onMessage = (msg) => {
        if (isMatchingStreamMessage(msg)) {
            queue.write(msg)
        }
    }

    client.connection.on(type, onMessage)
    queue.once('close', () => {
        client.connection.off(type, onMessage)
        if (signal) {
            signal.removeEventListener('abort', onAbort, {
                once: true,
            })
        }
    })
    return queue
}

function SubKey({ streamId, streamPartition = 0 }) {
    if (streamId == null) { throw new Error(`SubKey: invalid streamId: ${streamId} ${streamPartition}`) }
    return `${streamId}|${streamPartition}`
}

class Subscription {
    constructor(client, options) {
        this.client = client
        this.options = validateOptions(options)
        this.abortController = new AbortController()
        this.streams = new Set()

        this.queue = pLimit(1)
        const sub = this.subscribe.bind(this)
        const unsub = this.unsubscribe.bind(this)
        this.subscribe = () => this.queue(sub)
        this.unsubscribe = () => this.queue(unsub)
        this.return = this.return.bind(this)
        this.sendSubscribe = pMemoize(this.sendSubscribe.bind(this))
        this.sendUnsubscribe = pMemoize(this.sendUnsubscribe.bind(this))
    }

    hasPending() {
        return !!(this.queue.activeCount || this.queue.pendingCount)
    }

    async abort() {
        this.abortController.abort()
        await this.queue(() => {}) // pending tasks done
    }

    async sendSubscribe() {
        return subscribe(this.client, this.options)
    }

    async sendUnsubscribe() {
        return unsubscribe(this.client, this.options)
    }

    async subscribe() {
        pMemoize.clear(this.sendUnsubscribe)
        await this.sendSubscribe()
        return this.iterate()
    }

    async unsubscribe() {
        pMemoize.clear(this.sendSubscribe)
        await this.sendUnsubscribe()
    }

    async return() {
        await Promise.all([...this.streams].map(async (it) => {
            await it.return()
        }))
    }

    async _cleanup(it) {
        // if iterator never started, finally block never called, thus need to manually clean it
        this.streams.delete(it)
        if (!this.streams.size) {
            // unsubscribe if no more streams
            await this.unsubscribe()
        }
    }

    count() {
        return this.streams.size
    }

    iterate() {
        const it = iteratorFinally(messageStream(this.client, {
            signal: this.abortController.signal,
            ...this.options,
            type: ControlMessage.TYPES.BroadcastMessage,
        }), async () => (
            this._cleanup(it)
        ))
        this.streams.add(it)
        return it
    }

    [Symbol.asyncIterator]() {
        return this.iterate()
    }
}

async function resend(client, { requestId = uuid('rs'), streamId, streamPartition = 0, ...options } = {}) {
    const sessionToken = await client.session.getSessionToken()
    let request
    if (options.last > 0) {
        request = new ResendLastRequest({
            streamId,
            streamPartition,
            requestId,
            numberLast: options.last,
            sessionToken,
        })
    } else if (options.from && !options.to) {
        request = new ResendFromRequest({
            streamId,
            streamPartition,
            requestId,
            fromMsgRef: new MessageRef(options.from.timestamp, options.from.sequenceNumber),
            publisherId: options.publisherId,
            msgChainId: options.msgChainId,
            sessionToken,
        })
    } else if (options.from && options.to) {
        request = new ResendRangeRequest({
            streamId,
            streamPartition,
            requestId,
            fromMsgRef: new MessageRef(options.from.timestamp, options.from.sequenceNumber),
            toMsgRef: new MessageRef(options.to.timestamp, options.to.sequenceNumber),
            publisherId: options.publisherId,
            msgChainId: options.msgChainId,
            sessionToken,
        })
    }

    if (!request) {
        throw new Error("Can't _requestResend without resend options")
    }

    const onResponse = waitForRequestResponse(client, request)

    await client.send(request)
    return onResponse
}

export default class Subscriptions {
    constructor(client) {
        this.client = client
        this.subscriptions = new Map()
    }

    get(options) {
        const key = SubKey(validateOptions(options))
        return this.subscriptions.get(key)
    }

    abort(options) {
        const sub = this.get(options)
        return sub && sub.abort()
    }

    count(options) {
        const sub = this.get(options)
        return sub ? sub.count() : 0
    }

    async resend(opts) {
        const options = validateOptions(opts)
        const stream = messageStream(this.client, {
            ...options,
            type: ControlMessage.TYPES.UnicastMessage,
        })

        const it = iteratorFinally(stream)

        const requestId = uuid('rs')
        // eslint-disable-next-line promise/catch-or-return
        const onResendDone = waitForResponse({
            connection: this.client.connection,
            types: [
                ControlMessage.TYPES.ResendResponseResent,
                ControlMessage.TYPES.ResendResponseNoResend,
            ],
            requestId,
        }).then(() => {
            return stream.end()
        }, (err) => {
            return stream.destroy(err)
        })

        await Promise.race([
            resend(this.client, {
                requestId,
                ...options,
            }),
            onResendDone
        ])

        return it
    }

    async resendSubscribe(options) {
        const sub = await this.subscribe(options)
        const resendSub = await this.resend(options)

        return iteratorFinally((async function* ResendSubIterator() {
            yield* resendSub
            yield* sub
        }()), () => {
            return Promise.all([
                resendSub.return(),
                sub.return(),
            ])
        })
    }

    async subscribe(options) {
        const key = SubKey(validateOptions(options))
        const sub = (
            this.subscriptions.get(key)
            || this.subscriptions.set(key, new Subscription(this.client, options)).get(key)
        )

        return sub.subscribe()
    }

    async unsubscribe(options) {
        const key = SubKey(validateOptions(options))
        const sub = this.subscriptions.get(key)
        if (!sub) { return }

        // wait for any outstanding operations
        if (sub.hasPending()) {
            await sub.queue(() => {})
        }

        await sub.return() // close all streams (thus unsubscribe)
    }
}
