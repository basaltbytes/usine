---
"@usine/engine": minor
"@usine/orchestrator": patch
---

`RunReader.closed({ limit })` returns the `limit` settled Runs that closed last, newest close first, whenever they opened. A Run closed when its last Attempt ended, or started for one closed before end times were recorded; a Run canceled before any Attempt closed when it opened.

The desk's Last outcomes picks its Runs from `RunReader.closed` instead of the 100 newest settled Runs by opening time, so a Run that opened long ago and closed recently, such as one retried hours later, is listed.
