---
"@usine/server": patch
---

`usine up` checks its HTTP port right after taking the instance folder, before it opens any store or resumes any Attempt. When another process listens on the port, `usine up` exits at once and names that process's id where `lsof` can find it.
