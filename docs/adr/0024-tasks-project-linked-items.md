# Board tasks join explicitly linked Items and their Run histories

A feature often starts with a development Run on an issue and continues with review and fix Runs on its PR. Independent Item cards lose that continuity when the issue's trigger label disappears. The Board projects a Task from connected Items in one Project, with all their saved Runs in chronological order.

Relationships come from full PR URLs in an issue's observed `closedByPullRequestsReferences` or its saved Run results. URLs must identify a PR in the same repository. Number-only references in PR payloads can refer to another repository and do not establish a relationship. Titles, branches, and prompt text are never used to infer one. Items remain separate until both snapshots and an explicit relationship are available; the existing 500-Item Board window still applies.

The earliest issue number supplies the Task title. The Item with the newest open Run controls the lane. Between Runs, an open PR takes precedence, followed by the latest settled PR, then the originating issue. Existing label/state precedence applies to that current Item. Moves target its explicit GitHub number, and the UI names it. Approvals, failures, and cycle Asks on any member still mark the Task as needing attention.

The Task is a read projection without a stored identity or new execution lifecycle. Run ownership, deduplication, approval, retry, and per-Item cycle budgets stay with their existing records. Connected components avoid duplicate cards when several issues share a PR. The engine supplies all saved Run summaries for visible Items independently of the overview's recent-history limit, and each Run's existing drawer exposes its Attempts and transcript.

The UI reports Run and Attempt counts. It does not derive task cost from account rate-limit snapshots or duration from timestamps that do not record completion.
