---
"@usine/core": patch
"@usine/engine": patch
"@usine/executor": patch
"@usine/web": patch
---

The salvage commit leaves out the `.pnpm-store`, `node_modules`, and `.turbo` directories at any depth, even if the agent staged them, as well as what Git ignores. It also leaves out each file larger than GitHub's 100 MiB limit. Before, `git add --all` staged pnpm's store when pnpm created it in the checkout, which it does when its default store is on another filesystem, as in an SSH worker's container. GitHub then refused the push for its files over 100 MB, so the salvage kept the checkout and pushed nothing (#581). A checkout whose only changes are in those directories now has nothing to salvage. A salvage that leaves out a file over the size limit pushes the rest and records `PartlyPushed`, with a message that names the files and their sizes, so the worktree that has their only copy stays on the worker.

`@usine/core/attempt/salvage` adds `SalvagePartlyPushed` to `AttemptSalvage`, with the salvage `ref`, the pushed `commit`, the worktree's `path`, and a `message` that names the files left out. The engine resumes the run's next attempt from its `ref` and `commit`, as it does from a `Pushed` salvage. The executors keep its worktree, provisioned machine, or Cloudflare sandbox, as they do for a `Retained` one. The run drawer shows the pushed ref and commit, the worktree's path, and the files left out.
