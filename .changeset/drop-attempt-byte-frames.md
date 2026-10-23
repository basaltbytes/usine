---
"@usine/core": minor
---

Removes the run host byte protocol from `@usine/core/attempt/channel`: `Start`, `InputFrame`, `InputFrameFromJson`, `EnvelopeFromJson`, and `OutboundEnvelopeFromJson`. `admit` violation messages refer to the outbound channel instead of the run host.
