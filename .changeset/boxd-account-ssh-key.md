---
"@usine/executor": patch
---

Check the boxd worker SSH public key fingerprint against the API key account's linked keys during preflight. Unlinked keys fail with the fingerprint, file path, and operator setup instructions. Link keys from a signed-in session before preflight and after rotation; snapshots no longer require a worker key.
