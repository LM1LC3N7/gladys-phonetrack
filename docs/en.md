# PhoneTrack

The phones (and other trackers) of a [PhoneTrack](https://github.com/julien-nc/phonetrack)
session in Gladys. PhoneTrack is the location app of Nextcloud: your phones
send their position to your own Nextcloud (with the PhoneTrack Android app,
OwnTracks, GpsLogger, Traccar Client, uLogger...), and Gladys reads the last
one through the public, read-only link of the session.

- each PhoneTrack device becomes a Gladys device: **latitude**,
  **longitude**, **battery** (%), **accuracy** (m), **speed** (km/h),
  **altitude** (m), **bearing** (°), **satellites** (when the logger sends
  them), **last seen** and **silent**;
- a scene trigger **Device silent**: no new position for 15 minutes to 24
  hours (your choice in the scene).

Read only, pull only: Gladys reads Nextcloud at regular intervals. Nothing to
open on your network, no webhook: it works behind a NAT, as long as Gladys
can reach your Nextcloud.

> **This integration has never been tested with a real Nextcloud.** This
> first version was written from PhoneTrack's routes and documentation and
> tested against a fake PhoneTrack only. Please report what works and what
> does not on the Gladys forum.

Unofficial integration, not affiliated with PhoneTrack nor Nextcloud.

## Who is it for?

- **Without Gladys Plus**: Gladys has no ready-made way to receive the
  position of a phone (OwnTracks goes through the Gladys Plus gateway). With
  a Nextcloud of your own, this integration brings your phones into Gladys
  without Gladys Plus: where they are, their battery, and whether they still
  report.
- **With Gladys Plus**: OwnTracks already moves your user on the Gladys map.
  PhoneTrack adds what OwnTracks does not bring to Gladys: the **battery** of
  each phone, the **silence** of a phone (a scene when it stops reporting),
  and, on the Nextcloud side, the full **history** of the tracks and the
  **proximity alerts** between two devices (not in Gladys yet: see "Limits").

## Before you start: a read-only link

1. In Nextcloud, open **PhoneTrack**, select the session of your phones,
   and open its **Sharing** settings.
2. Turn **Public session** on. PhoneTrack then shows a **Public watch link**
   and an **API URL (JSON, last positions)**.
3. Copy the **API URL (JSON, last positions)**: it ends with
   `/apps/phonetrack/api/getlastpositions/<token>`. Paste it as is in the
   **Public token or API link** field of Gladys (or only the token, the last
   part, with the address of your Nextcloud in the other field).

Mind what this link gives: anyone who has it can see **every position of
the session**, in read only, without a password. Keep it like a password.
Gladys keeps it in its database, never shows it again, never writes it in a
log and sends it only to your Nextcloud. Turning **Public session** off in
PhoneTrack cuts the access at once (Gladys then sees a refusal).

The **Share link** entries of the same panel (filtered public shares) are
not supported by this version: use the API URL of the public session.

## Configuration

- **Nextcloud address**: `https://cloud.example.org`, with its folder if
  Nextcloud lives in one (`https://example.org/nextcloud`). May stay empty
  when the full API URL is pasted in the next field. `http://` is refused:
  the token is part of the address of the request and would cross the
  network in clear. A link with the token typed here (a field shown in
  clear) is refused too.
- **Public token or API link**: see above. When both fields are filled, the
  link must point to the same Nextcloud, otherwise nothing is sent.
- **Certificate fingerprint** (optional): by default the certificate of
  Nextcloud must come from a known authority (Let's Encrypt...). A Nextcloud
  with its own certificate: type its SHA-256 fingerprint; that certificate,
  and no other, is then accepted, checked before the token is sent. After a
  renewal, type the new one. To read it: your browser (padlock, certificate,
  SHA-256 fingerprint) or
  `openssl s_client -connect cloud.example.org:443 </dev/null | openssl x509 -noout -fingerprint -sha256`.
- **Refresh**: every 30 seconds to every 10 minutes (every minute by
  default). One request per reading. PhoneTrack only knows what the phones
  sent: their own logging interval matters as much.
- **Silent after**: 15 minutes to 24 hours (1 hour by default): the delay
  without a new position after which the **Silent** feature turns on.

Then open the **Discovery** tab and create the devices you want to follow.
Only the created devices get their values.

## What each feature shows

- **Latitude / Longitude**: the last position, in degrees, rounded to 6
  decimals (about 10 cm). Both are always sent together. They keep no
  history by default (privacy; you can turn the history on in the device).
- **Battery** (%): the battery of the phone at that point, when the logger
  sends it.
- **Accuracy** (m), **Altitude** (m), **Bearing** (°, 0 = north): as the
  logger sent them.
- **Speed** (km/h): PhoneTrack stores meters per second; Gladys converts.
  Some loggers (OwnTracks through PhoneTrack's OwnTracks address) send km/h,
  which PhoneTrack stores as is: their speed then shows 3.6 times too high.
- **Satellites**: only for the devices whose logger sends it (the feature
  appears in Discovery once seen; update the created device to add it).
- **Last seen**: the time of the last position, as `2026-10-18 08:00 UTC`
  (UTC: the time zone of Gladys is not known to the integration).
- **Silent** (1 / 0): no new position for the delay of the configuration.
  Computed from the time of the last point (the clock of the phone) and the
  clock of Gladys.
- A value the logger did not send is not published. Gladys accepts 300
  states per minute from an integration: this one sends at most 250, silent
  first, then the positions, the battery, the other numbers and the last
  seen text. With many devices created at once, the first values arrive
  over a few minutes.

## Scene trigger: Device silent

Choose the device (or any) and the delay (**required**: 15 minutes to 24
hours). The scene starts when the device has sent no new position for that
long, at the next reading. **Once per silence**: again only after a new
position. Never for a device that was already silent when the integration
started (no event at the first reading), never for a device seen for the
first time. Variables: device name, silent for (minutes), last seen.

## Connection problems

- **Token refused** (HTTP 401 or 403, or PhoneTrack's own "Session not
  found" 404: the session is not public any more, the token is wrong, or an
  authentication sits in front of Nextcloud): Nextcloud counts every refusal
  as an attack and may slow down or block the address of Gladys. Gladys
  therefore stops for **1 hour**, then **6 hours**, then **24 hours** after
  each new refusal, never in a loop. The stop is kept in `/data`: a restart
  or a reconnection of Gladys waits too, and so does the test button. Saving
  the configuration tries once at once (a new refusal goes one step
  further). A reading that works forgets the refusals.
- **Nextcloud busy** (HTTP 429, its brute-force protection) or **server
  error** (HTTP 5xx, maintenance): every request pauses, as long as
  Nextcloud asks (Retry-After) within 1 minute and 6 hours, never less than
  the refresh interval. The pause is kept in `/data`.
- **Not PhoneTrack** (a 404 page that is not PhoneTrack's answer, an
  unexpected answer): check the address and that the PhoneTrack app is
  enabled. Retried after the refresh interval (one minute at least), then
  the delay doubles up to 30 minutes.
- **Nextcloud unreachable** (network, timeout, certificate): same retries;
  the devices show as unreachable meanwhile. The integration never gives up.
- **Test the connection** reads again and says how many devices answer; it
  never shortens a stop nor a pause.

## Privacy

No position, device name, token or address is ever written to a log or to
the `/data` volume of the integration (it only keeps a salted digest of the
token after a refusal, and the end of a pause). The positions go only to
Gladys. The external ids of the devices are digests of the token and of the
device name, never the token itself. The user agent of the logger is never
read into Gladys.

## Limits

- **Gladys does not move a Gladys user on its map from PhoneTrack yet**: an
  integration cannot publish the position of a user today (only OwnTracks,
  through Gladys Plus, can). A small change of Gladys is needed; it is
  noted in the repository (TODO.md) and will come in a later version if
  Gladys accepts it. Until then, the zones of Gladys do not react to
  PhoneTrack.
- One PhoneTrack session per integration, 50 devices at most.
- Renaming a device in PhoneTrack makes a new Gladys device (the old one
  stays without values).
- Planned later: the geofences of PhoneTrack in push, presence per zone,
  the proximity of two devices, the history and GPX export, a "today's
  track" widget, several sessions, a "zone only" mode that never sends the
  exact position.
- Never tested with a real Nextcloud: see TODO.md in the repository.
