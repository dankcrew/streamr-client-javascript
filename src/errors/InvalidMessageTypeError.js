export default class InvalidMessageTypeError extends Error {
    constructor(message) {
        super(message)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor)
        }
    }
}
