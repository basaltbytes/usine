---
"@usine/server": patch
---

The board card menu offers **Run again** when the task's latest run succeeded or was canceled, with the run's loop beside it. While the request is sent, the card says "Opening a run…", also after it moves to another lane; the new run then opens in the drawer. When the item's cycle budget is used up, the card says that no run opened.

The event of a run that Run again opened links the run it ran again: its short id opens that run's page in the event document and on the task page.
