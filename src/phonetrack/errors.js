// -----------------------------------------------------------------------------
// PhonetrackError: every failure of a request to PhoneTrack, with a code the
// app maps to a status, a retry policy or a message. Messages never carry the
// share token nor any address (the token is part of the URL).
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  UNREACHABLE: 'unreachable', // no TCP connection
  TIMEOUT: 'timeout', // no answer in time
  TLS_UNTRUSTED: 'tls_untrusted', // certificate refused (self-signed, wrong name...)
  TLS_CHANGED: 'tls_changed', // differs from the typed fingerprint
  HTTP: 'http', // an HTTP status other than 2xx (see `status`)
  BAD_ANSWER: 'bad_answer', // not the JSON expected
  TOO_LARGE: 'too_large', // answer above the size cap
  CLOSED: 'closed', // the client was replaced (new configuration)
});

export class PhonetrackError extends Error {
  constructor(code, message, { status, retryAfterMs, envelope } = {}) {
    super(message);
    this.name = 'PhonetrackError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined && retryAfterMs !== null) this.retryAfterMs = retryAfterMs;
    /** The error body was PhoneTrack's own `{ "error": "<text>" }`, not a page of a proxy. */
    if (envelope !== undefined) this.envelope = envelope;
  }
}

/**
 * The error answer of PhoneTrack's API: a JSON object with an `error` text
 * (`{ "error": "Session not found" }` for a token it does not know).
 */
export function isPhonetrackEnvelope(body) {
  try {
    const value = JSON.parse(body.toString('utf8'));
    return (
      Boolean(value) &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof value.error === 'string'
    );
  } catch {
    return false;
  }
}

/**
 * The share refused: HTTP 401 or 403 (Nextcloud, or an authentication in
 * front of it), or HTTP 404 answered by PhoneTrack itself (the session is not
 * public any more, the share was deleted, the token is wrong). A 404 page that
 * is not PhoneTrack's answer (wrong address, app not installed) is not a
 * refusal. Nextcloud counts every refusal as a brute-force attempt: the app
 * stops for a long, growing delay.
 */
export const isRefused = (err) =>
  err?.code === CODES.HTTP &&
  (err.status === 401 || err.status === 403 || (err.status === 404 && err.envelope === true));
