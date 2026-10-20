---
"@usine/orchestrator": minor
"@usine/server": patch
---

`OperatorObservation.task(instance, repository, item)` in `@usine/orchestrator/operator` returns `TaskView`, the Task that holds Item `item`: its originating Item's number and title, its current Item and lane (`TaskLaneView`), its Items with their state, labels, and whether a pull request conflicts with its base (`TaskItemView`), every saved Run on those Items newest first, and the comments and reviews those Runs recorded as `Comment` facts (`TaskCommentView`), each dated by the end of the succeeded Attempt that recorded it. Membership and lane come from the Board projection over the Project's 500 newest Items, and Runs from `RunReader.forItems`. An Item outside that window fails with `BoardItemNotFoundError`, and a repository that is not a Project with `BoardProjectNotFoundError`. The operator API serves it at `GET /api/projects/:owner/:repository/tasks/:item`, in setup mode too.

The web UI adds the Task page at `/projects/<owner>/<name>/tasks/<number>`: the originating Item with its GitHub link, the current Item's state, lane, and labels, and Move to; every Run on the Task's Items with its outcome, failure reason, Attempts, duration, pull request, approval, and Run again, each opening its Run page, with the actions that apply; the Task's pull requests; and the comments and reviews its Runs posted. A click on a Board card opens it.
