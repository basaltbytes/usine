---
"@usine/server": patch
---

`usine up` checks its HTTP port before it opens any store or resumes any attempt. If the port is in use, it exits and shows the listening process's id when `lsof` finds it.
