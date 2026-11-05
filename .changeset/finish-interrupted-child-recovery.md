---
"@usine/durable": patch
---

Clear child holds and pauses when saved-session recovery returns an interrupted call so the attempt's wall-clock limit resumes. Continue forwarding transcript events and token reports after a failed progress checkpoint, and return the child's final report.
