---
"@usine/executor": patch
---

boxd worker preflight logs a warning when boxd stores the snapshot as `archiving`, `archived`, or `unarchiving`, because boxd creates machines only from a local snapshot. A region that boxd lists without an API endpoint fails preflight like an unknown region.

When boxd refuses a session before it expires, the boxd driver exchanges the API key again and retries the call once. It renews sessions 5 minutes before they expire. A token exchange that answers HTTP 400 or a server error other than 502, 503, or 504 fails as a worker fault instead of an outage that launch retries.

Every saved revision of a boxd worker with the same API key, region, and endpoint shares one API client and one `Exec` connection, instead of keeping two HTTP/2 session managers per revision until shutdown. Concurrent callers that wait for a boxd driver now share its build's result, so a boxd outage fails them together instead of one after another.
