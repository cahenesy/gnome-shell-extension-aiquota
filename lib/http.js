import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

/**
 * Minimal async HTTP layer over Soup 3.
 *
 * Everything is promise-based and every request takes the extension-wide
 * Gio.Cancellable, so `disable()` can guarantee no callback fires into a
 * torn-down extension.
 */

const DEFAULT_TIMEOUT_SECONDS = 10;

export class HttpError extends Error {
    constructor(status, reason, body) {
        super(`HTTP ${status} ${reason || ''}`.trim());
        this.name = 'HttpError';
        this.status = status;
        this.reason = reason;
        this.body = body;
    }

    /** 401/403 mean the token is bad; retrying on a timer will never fix it. */
    get isAuthFailure() {
        return this.status === 401 || this.status === 403;
    }

    get isRateLimited() {
        return this.status === 429;
    }
}

export function createSession(userAgent) {
    const session = new Soup.Session();
    session.timeout = DEFAULT_TIMEOUT_SECONDS;
    session.idle_timeout = DEFAULT_TIMEOUT_SECONDS;
    if (userAgent)
        session.user_agent = userAgent;
    return session;
}

/**
 * GET `url`, resolving to the decoded body string.
 *
 * @param {Soup.Session} session
 * @param {string} url
 * @param {object} [options]
 * @param {object} [options.headers] header name -> value
 * @param {Gio.Cancellable} [options.cancellable]
 * @returns {Promise<{status:number, body:string, headers:Soup.MessageHeaders}>}
 */
export function get(session, url, options = {}) {
    const {headers = {}, cancellable = null} = options;

    return new Promise((resolve, reject) => {
        let message;
        try {
            message = Soup.Message.new('GET', url);
        } catch (e) {
            reject(e);
            return;
        }
        if (message === null) {
            reject(new Error(`Could not build a request for ${url}`));
            return;
        }

        const requestHeaders = message.get_request_headers();
        for (const [name, value] of Object.entries(headers)) {
            if (value !== null && value !== undefined)
                requestHeaders.append(name, String(value));
        }

        session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (self, result) => {
                let bytes;
                try {
                    bytes = self.send_and_read_finish(result);
                } catch (e) {
                    reject(e);
                    return;
                }

                const status = message.get_status();
                const reason = message.get_reason_phrase();
                const data = bytes?.get_data();
                let body = '';
                if (data && data.length > 0) {
                    try {
                        body = new TextDecoder('utf-8').decode(data);
                    } catch {
                        body = '';
                    }
                }

                if (status < 200 || status >= 300) {
                    reject(new HttpError(status, reason, body));
                    return;
                }

                resolve({status, body, headers: message.get_response_headers()});
            }
        );
    });
}

/** GET and JSON.parse, with a clearer error than SyntaxError when the body is not JSON. */
export async function getJson(session, url, options = {}) {
    const {body} = await get(session, url, options);
    try {
        return JSON.parse(body);
    } catch (e) {
        const preview = body.slice(0, 120).replace(/\s+/g, ' ');
        throw new Error(`Expected JSON from ${url} but got: ${preview}`);
    }
}

/** True when a rejection is simply "we cancelled it", which is never an error worth showing. */
export function isCancelled(error) {
    return error instanceof Gio.IOErrorEnum
        ? error === Gio.IOErrorEnum.CANCELLED
        : error?.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED) ?? false;
}
