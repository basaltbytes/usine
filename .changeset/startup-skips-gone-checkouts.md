---
"@usine/engine": patch
"@usine/executor": patch
"@usine/server": patch
---

Startup recovery stops tracking a finished attempt whose checkout is gone from the long-lived machine of an SSH or exe.dev worker, so later starts skip it. Before, `recover` returned `found` whenever the worker's machine answered, and every start visited each attempt the worker ever ran. A machine created for one attempt still counts as a leftover until it is deleted. The per-worker summary "Startup checkout reconciliation finished on a Worker" now splits `kept` into `kept` (leftovers found or kept on the worker), `failed` (reconciliation failed), and `empty` (still tracked, with nothing left on the worker).

On an SSH worker, that recovery also removes the attempt's saved connection record, even if another attempt's cleanup failed on the same machine, and logs that removal at Info. Each attempt that startup keeps tracking now logs why at Info.
