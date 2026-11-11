---
"@usine/agents": patch
---

A remote child whose process owner fails during setup, for example because the owner cannot read its own process identity, now fails at once with the owner's reason as its exit diagnostic. Before, the relay waited 10 seconds and exited without one.
