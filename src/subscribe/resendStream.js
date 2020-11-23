import { ControlLayer } from 'streamr-client-protocol'

import { counterId } from '../utils'

import { validateOptions, waitForResponse, resend } from './api'
import messageStream from './messageStream'

const { ControlMessage } = ControlLayer

export default function resendStream(client, opts = {}, onFinally = () => {}) {
    const options = validateOptions(opts)
    const { connection } = client
    const requestId = counterId(`${options.key}-resend`)
    const msgStream = messageStream(client.connection, {
        ...options,
        isUnicast: true,
    }, async (...args) => {
        try {
            await connection.removeHandle(requestId)
        } finally {
            await onFinally(...args)
        }
    })

    const onResendDone = waitForResponse({ // eslint-disable-line promise/catch-or-return
        requestId,
        connection: client.connection,
        types: [
            ControlMessage.TYPES.ResendResponseResent,
            ControlMessage.TYPES.ResendResponseNoResend,
        ],
    }).then(() => (
        msgStream.end()
    ), (err) => (
        msgStream.cancel(err)
    ))

    // wait for resend complete message or resend request done
    return Object.assign(msgStream, {
        async subscribe() {
            await connection.addHandle(requestId)
            // wait for resend complete message or resend request done
            await Promise.race([
                resend(client, {
                    requestId,
                    ...options,
                }),
                onResendDone
            ])
            return this
        },
        async unsubscribe() {
            return this.cancel()
        }
    })
}