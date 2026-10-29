---
"@usine/server": patch
---

Fix durable backup filenames for destinations with dots. Preserve only `.sqlite` and `.db` extensions; append `.durable.sqlite` to all other destination names.
