---
"@usine/server": patch
---

The web UI's Tasks list shows the last Run's time at the end of the status, such as `Done · 28m ago`, and no longer has a Last run column; a stall reason such as `Canceled 3d ago, unchanged since` keeps its own time. The Elapsed time and Estimated cost columns show the figure alone, without `at least` or `estimate`. A muted `*` marks a figure lower than the real one: an elapsed time with attempts that have no recorded timing, such as `0s*`, with the reason in its tooltip, and a cost with usage not priced yet, such as `$9.95*`, with the reason at the top of its hover. The line under the heading uses the headers' words and the same mark, such as `197 runs, 12 h 8 min* elapsed, 127.5M tokens, $134.34* estimated`, each `*` explained in its tooltip. The figure columns reserve only the width their headers and figures need, so titles get the room.
