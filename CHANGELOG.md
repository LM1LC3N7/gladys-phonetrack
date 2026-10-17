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
  scene): once per silence, never for a device already silent at start.
- Refresh every 30 seconds to 10 minutes (1 minute by default); "Silent
  after" delay of 15 minutes to 24 hours (1 hour by default).
- The token, or the whole API link, kept by Gladys and never shown again,
  never logged; strict TLS or a pinned SHA-256 fingerprint; http:// refused.
- A refused token (HTTP 401 / 403, or PhoneTrack's "Session not found")
  stops for 1 h, then 6 h, then 24 h, kept in `/data`; HTTP 429 and 5xx
  pause every request, bounded and kept in `/data`.
- Button "Test the connection".
