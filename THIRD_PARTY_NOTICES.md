# Third-party notices

No third-party code is copied into this integration, and nothing but the
Gladys SDK is installed at runtime.

## PhoneTrack

PhoneTrack (<https://github.com/julien-nc/phonetrack>, a Nextcloud app under
the GNU AGPL-3.0) is only talked to: this integration calls its public,
read-only HTTP API `GET /index.php/apps/phonetrack/api/getlastpositions/<token>`,
the "API link" PhoneTrack shows in the public sharing settings of a session.
The route and the shape of the answer were read in its `appinfo/routes.php`,
its controller and its user documentation (version 1.3.5, commit `827b8a3`).
No line of PhoneTrack's code is used, copied or adapted. PhoneTrack and
Nextcloud are trademarks of their owners; this integration is unofficial and
not affiliated with them.

## guim31/gladys-nextcloud

<https://github.com/guim31/gladys-nextcloud> (Apache-2.0, read at commit
`c721a70`): a Gladys integration for the same server. It showed how
Nextcloud's brute-force protection answers (slow answers, then HTTP 429)
and that a refused request must slow the integration down. No code is
copied.

## LM1LC3N7/gladys-netbird

The structure of the app (start queue, epochs of the loop, refusal kept as
a salted HMAC in `/data`, bounded pauses, state budget, transport badges,
never a smaller device), the HTTP transport with a fingerprint checked
before the request, and the test helpers follow this integration of the
same author, under the Apache License 2.0 of this repository. The test
certificates of `test/fixtures/tls/` come from it (test material only).
