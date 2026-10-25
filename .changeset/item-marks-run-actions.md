---
"@usine/orchestrator": patch
"@usine/server": patch
---

Board items now include their GitHub state (`BoardItemLink.state`), so every view that lists an item can show whether it is open, closed, or merged.

The web UI shows each issue and pull request the same way on every page: its GitHub icon and number in GitHub's state colour, linked to GitHub. A task is named after its earliest issue, or its pull request if it has no issue, with that item's number inline in the title. The run page, the run drawer, and the task page share one header. Run actions depend on the run's state: for a question from the agent, **Mark answered** is the primary action, and actions that apply less often are under **More actions**.
