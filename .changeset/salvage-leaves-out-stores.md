---
"@usine/executor": patch
---

The salvage commit leaves out the `.pnpm-store`, `node_modules`, and `.turbo` directories at any depth, as well as what Git ignores, even if the agent staged them. It also leaves out each file larger than GitHub's 100 MiB limit, and a warning names those files and their sizes. Before, `git add --all` staged pnpm's store when pnpm created it in the checkout, which it does when its default store is on another filesystem, as in an SSH worker's container. GitHub then refused the push for its files over 100 MB, so the salvage kept the checkout and pushed nothing (#581). A checkout whose only changes are left out now has nothing to salvage.
