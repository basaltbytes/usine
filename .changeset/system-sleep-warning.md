---
"@usine/server": patch
---

On macOS, `usine up` reads `pmset -g` at startup and logs a warning if system sleep is on and `caffeinate` doesn't prevent it ([#603](https://github.com/basaltbytes/usine/issues/603)). A sleep drops the orchestrator's SSH connections to workers and the gateway. Run `caffeinate -s` while runs are open, or turn off sleep on AC power with `sudo pmset -c sleep 0`. The check doesn't stop startup.
