---
"@usine/server": patch
---

In a supervisor conversation, the prompt input's button is **Stop** while a turn runs and the message box is empty, and it cancels that turn. With text in the box, the button is **Send**, and the message queues after the running turn. The **Cancel turn** button under a running turn is gone; a queued turn keeps **Cancel turn** on its own row and asks for **Confirm cancel** first. The tool calls between two texts of a turn fold into one line, as in the run reader, that counts failed calls and opens to one row per call. While a turn runs, a line under the fold shows the running call and its subject.
