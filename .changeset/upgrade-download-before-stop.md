---
"@usine/server": patch
---

The upgrade helper downloads the target version into the npm cache before it stops the server. When the registry answers `E404` or `ETARGET`, the helper retries the download up to three times, 60 seconds apart, while the server keeps running. If the download fails, the helper records a failed upgrade that says the server and packages were not changed, and the server keeps running. After the stop, the helper installs from the npm cache, so the server is no longer stopped while the registry makes a new archive available.

When the helper records a failed upgrade while the server still runs, after a failed download, space check, or backup, the server resumes attempt admission without a restart. **Settings** shows the recorded reason. Automatic mode doesn't retry the failed version, but it requests the next newer version.
