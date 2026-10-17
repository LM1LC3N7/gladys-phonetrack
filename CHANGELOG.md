# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version, never tested with a real Nextcloud: the devices of one
  public PhoneTrack session, read through its read-only API link
  (`api/getlastpositions/<token>`), in pull (works behind a NAT). Read only.
- One Gladys device per PhoneTrack device: latitude, longitude, battery,
  accuracy, speed (km/h), altitude, bearing, satellites (when sent), last
  seen and silent (read only).
- Scene trigger "Device silent" (15 minutes to 24 hours, chosen in the
  scene): once per silence, never for a delay already reached at start.
- Refresh every 30 seconds to 10 minutes (1 minute by default); "Silent
  after" delay of 15 minutes to 24 hours (1 hour by default).
- The token, or the whole API link, kept by Gladys and never shown again,
  never logged; strict TLS or a pinned SHA-256 fingerprint; http:// refused.
- A refused token (HTTP 401 / 403, or PhoneTrack's "Session not found")
  stops for 1 h, then 6 h, then 24 h, kept in `/data`; HTTP 429 and 5xx
  pause every request, bounded and kept in `/data`.
- Button "Test the connection".

### Changed (review before the first release)

- A refusal or a pause answered while Gladys disconnected (or while the
  configuration changed) is kept in `/data`; an attempt after a refusal
  still in flight at a stop counts as a refusal; within a series of
  refusals, a timeout waits for the end of the step.
- Saving the same refused token makes one attempt per series of refusals
  (another token or address: at once); the status says when the next one is.
- One device with an impossible date no longer blocks the reading; an
  internal error or a too large answer is said as such.
- Trigger "Device silent": devices created in Gladys only; a late batch of
  old points never fires again; no event after a clock jump nor from a point
  in the future; at most 30 events per reading, the rest at the next one.
- The cap of 50 devices keeps the created devices first; a session encoded
  as a list is read; watch-page links are refused with a clear message.
- A 403 names a firewall or a proxy as a possible cause; timeout 45 s; the
  configuration not given by Gladys at a reconnection falls back on the last
  one, or is read again every minute.
