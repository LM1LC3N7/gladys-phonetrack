// -----------------------------------------------------------------------------
// The read-only public API of PhoneTrack (a Nextcloud app):
//   GET <nextcloud>/index.php/apps/phonetrack/api/getlastpositions/<token>
// with the public token of a session whose public sharing is on (the "API
// link" PhoneTrack shows in the sharing settings of the session). Read only:
// nothing to expose, works behind a NAT. The token is part of the path: no URL
// is ever logged or put in an error message. Nothing of PhoneTrack's own code
// (AGPL-3.0) is used: only its HTTP API.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { API_PATH, MAX_BYTES, TIMEOUTS } from '../constants.js';
import { CODES, PhonetrackError, isPhonetrackEnvelope } from './errors.js';
import { httpRequest } from './http.js';
import { parseLastPositions } from './parse.js';

const asNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Seconds of a Retry-After header (delta form only), in ms, or null. */
const retryAfterMs = (value) => {
  const seconds = asNumber(Array.isArray(value) ? value[0] : value);
  return seconds !== null && seconds >= 0 ? seconds * 1000 : null;
};

/** gladys-phonetrack/<version>, from package.json (copied into the image). */
export const USER_AGENT = (() => {
  try {
    const { version } = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    return typeof version === 'string' ? `gladys-phonetrack/${version}` : 'gladys-phonetrack';
  } catch {
    return 'gladys-phonetrack';
  }
})();

export class PhonetrackClient {
  /**
   * @param {object} options
   * @param {{ base: string }} options.server the Nextcloud address (no `/index.php`)
   * @param {string} options.token the public token of the session
   * @param {string | null} [options.fingerprint] SHA-256 fingerprint typed by the user
   * @param {Function} [options.request] the HTTP transport (tests inject a fake PhoneTrack)
   */
  constructor({ server, token, fingerprint = null, request = httpRequest }) {
    this.server = server;
    this.token = token;
    this.fingerprint = fingerprint;
    this.request = request;
    this.closed = false;
  }

  close() {
    this.closed = true;
  }

  /** The devices of the session with their last point. Rejects a PhonetrackError. */
  async lastPositions() {
    if (this.closed) throw new PhonetrackError(CODES.CLOSED, 'Client closed');
    const response = await this.request(
      `${this.server.base}${API_PATH}${encodeURIComponent(this.token)}`,
      {
        headers: { 'user-agent': USER_AGENT },
        timeout: TIMEOUTS.API,
        maxBytes: MAX_BYTES,
        tls: this.fingerprint ? { fingerprint: this.fingerprint } : {},
      },
    );
    if (response.status < 200 || response.status > 299) {
      throw new PhonetrackError(CODES.HTTP, `HTTP ${response.status}`, {
        status: response.status,
        retryAfterMs: retryAfterMs(response.headers?.['retry-after']),
        envelope: isPhonetrackEnvelope(response.body ?? Buffer.alloc(0)),
      });
    }
    let value;
    try {
      value = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new PhonetrackError(CODES.BAD_ANSWER, 'Not JSON');
    }
    const devices = parseLastPositions(value, this.token);
    if (!devices) throw new PhonetrackError(CODES.BAD_ANSWER, 'Not the answer of PhoneTrack');
    return devices;
  }
}
