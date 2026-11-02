---
"@usine/server": patch
---

Keep the newest three managed upgrade backups after successful upgrades, with configurable retention and an external backup directory. Refuse upgrades when either the backup or instance filesystem has less free space than twice the database and WAL sizes, leaving the server and packages unchanged.
