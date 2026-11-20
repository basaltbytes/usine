---
"@usine/core": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Conversation answers, run transcripts, and agent questions link what usine knows. A task on the project's board, written `#<number>` or `<owner>/<name>#<number>`, shows as a chip with the task's item mark, title, and status in the colors of the Tasks list, and opens the task page; the chip follows the board, so a task that closes or changes status updates without a reload. A number that no card has opens the issue or pull request on GitHub. A run on the board, written as its ID, shows its state mark and loop and opens the run page; another run ID opens its run page from a plain link. In a code span, a loop, agent, or worker name opens its configuration page, a repository label shows as its badge, and `<owner>/<name>/<path>:<line>` opens that line on GitHub at the commit that the supervisor turn read. A Markdown link to a path that a page of the app matches opens that page in the same tab; other relative links and unknown pages stay text. References in code blocks, tasks in a project the member can't read, and paths outside the turn's source stay text.

`SupervisorMessage` and `Reply` in `@usine/core/conversation` have `sources`, a `TurnSource` with the `repository` and `revision` for each repository whose source the turn read; an answer stored earlier decodes with none. The orchestrator stores the source that each turn mounted on its answer, and the turn's context gives the supervisor the reference forms that the web UI links and the paths of its pages.
