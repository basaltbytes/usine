---
"@usine/core": minor
---

`@usine/core/attempt/channel` drops the byte protocol only the run host spoke: `Start`, `InputFrame`, `InputFrameFromJson`, `EnvelopeFromJson`, and `OutboundEnvelopeFromJson` are removed. The envelopes, `RunSpec`, `Sink`, `PROTOCOL_VERSION`, and `admit` are unchanged; `admit` violation messages now name the outbound channel instead of the run host.
