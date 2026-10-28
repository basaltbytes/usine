---
"@usine/orchestrator": minor
"@usine/server": minor
---

Add npm channel checks and browser upgrades for global server installations managed by systemd. Automatic upgrades wait for running attempts to finish; a separate helper restores the previous package version if the new operator API fails to start. Configure the channel and mode with `usine config edit settings instance` and install the helper service from the server guide.
