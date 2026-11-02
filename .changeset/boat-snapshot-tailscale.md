---
"@usine/executor": patch
---

Log missing attempt images on Boat machines at Info level without snapshot rebuild advice. Boat snapshots do not retain container images; each new machine pulls the image during preflight.
