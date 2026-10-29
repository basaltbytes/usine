---
"@usine/executor": patch
---

Add `githubBotLogin(kind, appLogin)` to share the GitHub writer mapping between the scheduler and run reader. Local, SSH, and Cloudflare workers use the supplied App login; exe.dev workers use the integration bot declared in the exe.dev adapter.
