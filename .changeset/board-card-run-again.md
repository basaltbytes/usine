---
"@usine/server": patch
---

The Board card menu offers **Run again** when the task's latest Run succeeded or was canceled, with the Run's Loop beside it. While the request is sent, the card says "Opening a run…", also after it moves to another lane; the new Run then opens in the drawer. When the Item's cycle budget is used up, the card says that no run opened.

The Event of a Run that Run again opened links the Run it ran again: its short id opens that Run's page in the Event document and on the Task page.
