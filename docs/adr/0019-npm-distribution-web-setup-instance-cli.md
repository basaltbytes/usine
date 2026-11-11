# npm distribution, setup in the web UI, and a CLI that manages the instance

usine ships only on npm, because the local worker and the harness CLIs need Node anyway. `@usine/server` provides the `usine` CLI and bundles the web UI. An operator installs it globally, or runs `npm create usine`, which writes a folder that exact-pins the server and installs it. Neither creates a git repository: the instance folder holds runtime data and credentials, and configuration is in the database ([ADR 0031](./0031-authored-configuration-in-the-database.md)).

The first `usine up` without GitHub App credentials serves setup in the web UI, because the server already has the redirect endpoint that GitHub's manifest flow needs. Setup creates the App, saves its credentials with mode 0600, checks the installation, makes the person who signs in the first admin ([ADR 0030](./0030-operator-api-authentication-and-access-control.md)), connects model logins, and starts the runtime in the same process. Each step resumes where an earlier start stopped.

The CLI manages the instance: `up`, `status`, `stop`, `restart`, and `upgrade`. Every command reads the folder's `.env`. When systemd or a configured launchd job runs the server, the CLI goes through that service manager, so the manager never restarts a process that the CLI stopped.

Releases reach `latest` through the Version Packages pull request, once an npm maintainer approves the staged versions. Prereleases of `main` reach `next` only when someone starts the release workflow, so each collects several changes; the project's own instance upgrades from `next`. [Releasing](../releasing.md) holds the procedure.

A global installation under systemd or launchd follows a channel, `latest` or `next`. A separate helper service upgrades it, so that the rollback survives the server's stop: it backs up the databases, installs the target, and restores the previous package and databases if the install or the new version's health check fails. A pinned folder upgrades by moving its pin, so instances on one machine keep their own versions.

## Considered options

- **A binary or a Docker image first**: a containerized orchestrator can't share a local worker's toolchain, worktrees, and logins.
- **A CLI setup wizard**: a second redirect server and a second repository picker.
