---
"@usine/server": patch
---

Print startup sign-in links only on terminals. Check local admin token ownership and reject symbolic links, and fail lifecycle commands when the token file is unreadable or unsafe. Record token use at most once a minute, delete expired credentials when listing tokens, and revoke GitHub user tokens after reading identity.
