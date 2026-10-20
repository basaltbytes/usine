---
"@usine/orchestrator": patch
---

`Operator.detail` reads an ended Attempt's token reports once and keeps them in memory until the orchestrator restarts, since an Attempt's transcript gets no report after its outcome is recorded. The Run page and the drawer, which poll the detail every second while a Run can be canceled, now read only the Attempt in flight.
