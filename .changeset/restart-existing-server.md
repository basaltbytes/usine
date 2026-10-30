---
"@usine/server": patch
---

Restart the previous server after a failed upgrade or rollback install when that version remains installed. Preserve the original upgrade failure reason after recovery, and request a manual reinstall only when the installed version matches neither the target nor the previous version.
