---
"@usine/executor": patch
---

Retry missing attempt image pulls on the same SSH worker machine after 5 seconds and then 15 seconds before failing preflight. Log each pull attempt and include up to 1,000 characters of stderr in failed pull warnings.
