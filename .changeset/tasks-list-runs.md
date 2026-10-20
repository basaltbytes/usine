---
"@usine/server": patch
---

The web UI's Tasks list shows usine's work per Task: only the Tasks with at least one Run, finished ones included, with no Done toggle and no `?done=1`. Each row shows the status, the Loops that ran with their last Run's state and the Run count, the last Run, and the pull request with its state, such as `#425 merged`. The status is `Running` with the Loop, `Waiting for approval`, the stall reason, `Needs attention`, `Done`, or the last Run's outcome, such as `Failed`. Tasks in flight come first, by when their Run opened, then every other Task by when its last Run ended; GitHub's update time is no longer a sort key. The heading counts `2 in flight, 1 needs attention, 2 done`, and a project where no Task has a Run says `No runs yet`.
