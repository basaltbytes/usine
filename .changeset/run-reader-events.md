---
"@usine/engine": minor
---

`RunReader.events(runIds)` reads, in one batch, the Event each Run was opened for, as `RunEvent` records of the Run's id and its Event. The Event's payload is the Item as the trigger saw it, before the Run's Agent changed it. A Run that does not exist is left out, and a Run named twice is read once.
