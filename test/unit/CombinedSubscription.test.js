import assert from 'assert'

import sinon from 'sinon'
import { ControlLayer, MessageLayer } from 'streamr-client-protocol'

import CombinedSubscription from '../../src/CombinedSubscription'

const { StreamMessage, MessageIDStrict, MessageRef } = MessageLayer

const createMsg = (
    timestamp = 1, sequenceNumber = 0, prevTimestamp = null,
    prevSequenceNumber = 0, content = {}, publisherId = 'publisherId', msgChainId = '1',
    encryptionType = StreamMessage.ENCRYPTION_TYPES.NONE,
) => {
    const prevMsgRef = prevTimestamp ? new MessageRef(prevTimestamp, prevSequenceNumber) : null
    return new StreamMessage({
        messageId: new MessageIDStrict('streamId', 0, timestamp, sequenceNumber, publisherId, msgChainId),
        prevMsgRef,
        content,
        contentType: StreamMessage.CONTENT_TYPES.MESSAGE,
        encryptionType,
        signatureType: StreamMessage.SIGNATURE_TYPES.NONE,
        signature: '',
    })
}

const msg1 = createMsg()

describe('CombinedSubscription', () => {
    it('handles real time gap that occurred during initial resend', (done) => {
        const msg4 = createMsg(4, undefined, 3)
        const sub = new CombinedSubscription(msg1.getStreamId(), msg1.getStreamPartition(), sinon.stub(), {
            last: 1
        }, {}, 100, 100)
        sub.addPendingResendRequestId('requestId')
        sub.on('gap', (from, to, publisherId) => {
            assert.equal(from.timestamp, 1)
            assert.equal(from.sequenceNumber, 1)
            assert.equal(to.timestamp, 3)
            assert.equal(to.sequenceNumber, 0)
            assert.equal(publisherId, 'publisherId')
            setTimeout(() => {
                sub.stop()
                done()
            }, 100)
        })
        sub.handleResending(new ControlLayer.ResendResponseResending({
            streamId: 'streamId',
            streamPartition: 0,
            requestId: 'requestId',
        }))
        sub.handleResentMessage(msg1, 'requestId', sinon.stub().resolves(true))
        sub.handleBroadcastMessage(msg4, sinon.stub().resolves(true))
        sub.handleResent(new ControlLayer.ResendResponseNoResend({
            streamId: 'streamId',
            streamPartition: 0,
            requestId: 'requestId',
        }))
    })
})
