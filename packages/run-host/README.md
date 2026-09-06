# @usine/run-host

The worker-side process for one [usine](https://github.com/basaltbytes/usine) Attempt. Installations receive the `usine-run-host` executable; embedders can import its absolute Node command from `@usine/run-host/executable`.

The host uses protocol v4 as newline-delimited JSON. Its first input must be a secret-free `Start` frame containing the repository, payload snapshot, rendered task, named agent, requested parent model, and child-session budget. After launch, `Started` records the SDK-selected parent model. Normalized parent and child `SessionEvent` envelopes follow. A launch error sends `Failed` as the first and terminal frame; a started session closes with one `Final`, `Failed`, or `Interrupted` envelope. The host accepts steer and interrupt envelopes while the session runs. `usine-run-host --protocol-version` prints the supported wire version for worker preflight checks.

The executable runs the production Pi parent with Claude Code, Codex, and Pi child backends. `--stub` and `--stub-delay-ms` select the deterministic adapter used by process tests. Runtime logs and process-console output go to stderr because stdout belongs exclusively to the attempt channel, including logs from libraries with separate Effect runtimes.

After the agent session finishes, the host records commits created after the supplied base commit. For a changed checkout, an agent-created branch, or an Attempt pinned to a commit, it also asks GitHub for PRs whose head matches the final checkout commit. These structured `PullRequest` facts persist with the result and supply the operator's PR link. Discovery uses `gh api` with the worker's existing repository access, including the exe.dev GitHub host; it does not parse the agent's message. A failed lookup or ten-second timeout logs a warning and preserves the completed agent result. Worker images need the GitHub CLI for PR discovery.

Run `pnpm --filter @usine/run-host test` from the workspace to exercise the production host through an in-memory stdio harness. The suite covers protocol validation, session interruption and cleanup, and commit harvesting from temporary Git repositories. Agent sessions and GitHub responses are controlled test adapters; tests require Git and Node.js and run without agent or GitHub credentials.

Everything is 0.x, so APIs may change. Supply `effect` at the version pinned by the usine workspace.
