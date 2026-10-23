# One GitHub App is the instance's identity; worker credentials are per-attempt, single-repo, short-lived

The instance authenticates to GitHub as one operator-owned **GitHub App**, created by the manifest flow at bootstrap and installed on the managed repos. All usine GitHub actions (polling, label writes, pushes, PRs, comments) use it (`<app>[bot]`); agents share it, named in content signatures and the run record. The default manifest requests only what the acceptance loops need (`metadata:read`, `contents:read+write`, `issues:read+write`, `pull_requests:read+write`, `checks:read`) and deliberately **excludes `workflows:write`** and admin scopes. Branch protection, not a missing permission, limits merging.

Only the orchestrator has the App private key (a 0600 secrets file in the gitignored `.usine/`; environment variables override). It mints tokens of at most 1 hour: installation-wide for polling and UI writes, and **per attempt, scoped to its single repo** for workers. Attachment is adapter-internal (ADR 0006): the local executor puts the token in the run host's environment, and exe.dev uses its **native GitHub integration** (per-repo grants attached `--for` the attempt's window, injected at exe.dev's edge, never on the VM). The installation must cover the registry; drift shows as a per-project needs-you error while covered repos keep running. Loop gates (approval, CEL over the payload's `authorAssociation`) limit untrusted content, not an engine trust mechanism.

## Considered options

- **Fine-grained PAT**: simplest bootstrap, but it _is_ the operator: agent activity looks like theirs, doesn't notify them, shares their 5,000 requests/hour pool, and lasts until revoked. Rejected, with a PAT quick-start mode, to avoid a second credential path.
- **GitHub App** (chosen): its own bot identity and notifications, a separate rate pool (5,000 scaling to 12,500), short-lived per-repo tokens, the installation list for scoping, and the webhook deliveries feed (#18), at the cost of manifest-flow setup (#23) and key custody.
- **Per-agent GitHub identities**: one App per agent gives real attribution and revocation, but multiplies setup and key custody per agent. Out of scope: one identity plus a signature.
- **Static PAT or installation-wide refreshed token on workers**: a long-lived PAT reopens what the App closed, and an installation-wide token exposes every managed repo. Rejected for the per-attempt single-repo token.
- **exe.dev attachment mode**: routing usine's token through exe.dev's generic HTTP-proxy integration keeps one identity and gives exe.dev no standing access; writing the token on the VM matches the local adapter. The **native integration** won as zero-code and platform-standard, accepting its two costs below.
- **`workflows:write` by default**: lets CI-repair agents fix workflow files, but a leaked token could turn CI into an exfiltration path. Excluded; the operator can grant it later.

## Consequences

- A compromised worker exposes one GitHub token of at most 1 hour (or an expiring edge grant) for one repo, harness logins (Claude or ChatGPT, limited by provider device revocation), the Pi API key (limited by rotation and spend caps), and its cached clones. Never on a worker: the App private key, other repos' tokens, the runtime store, other workers' credentials.
- exe.dev pushes are attributed to `exe-dev-github-integration[bot]` (or the operator with `--act-as-user`), not the instance's bot; the agent signature attributes the work across worker classes. exe.dev also keeps a standing App connection to granted repos, an accepted second trust root.
- With concurrent attempts across repos, an exe.dev VM briefly has edge grants for every repo it runs: per-attempt scoping limits each grant in time, not the VM to one repo. A third accepted cost, fixable by running one repo per VM at a time.
- Bootstrap (#23) adds the App setup: manifest creation, installation, and the key in `.usine/`.
- Polling (ADR 0007) uses tokens the orchestrator mints, so the operator's own rate pool is untouched; conditional 304s stay free.
- CI-repair loops can't edit `.github/workflows/` by default. The failure is a typed push rejection; the remedy is an explicit grant on the App.
- Per-loop permission subsets (for example, read-only review tokens) can be added: the mint API accepts subsets, and nothing in the seam prevents it.

[ADR 0022](./0022-item-cycle-budgets-and-comment-reviews.md) extends this decision with durable item cycle budgets, operator reset asks, and comment-only reviews under the shared App identity. [ADR 0026](./0026-eu-ssh-worker.md) gives SSH workers the local worker's per-attempt token, written on the machine for the attempt.

## Amendment (2026-10-19, #226): a loop sets its attempts' token permission level

On 2026-10-12, a review run pushed a fix to the PR it reviewed despite its prompt, because every token had `contents: write`. A loop now sets `permissions: write` (default) or `permissions: read`, and each attempt's single-repo token is minted at that level. A `read` token has `contents: read`, so GitHub refuses its pushes, merges, and branch updates, but keeps `pull_requests: write` and `issues: write` for reviews and comments: `read` limits code, not the item. Its labels can still trigger other loops, which is how review loops hand work on. The sets are `WORKER_TOKEN_PERMISSIONS` in `@usine/github`. The level belongs to the loop, which says what a step is for; a per-scope list would put GitHub's permission model in loop files, and two levels suffice.

The token is the boundary on every worker kind, and the local worker's allowlisted environment contains no other credential. A local attempt still runs as the operator's Unix user and can read their home directory's credentials ([#384](https://github.com/basaltbytes/usine/issues/384)). On an SSH worker, attempts share one Unix user and can read each other's token files, or caller tokens behind a gateway, so `read` doesn't stop a `read` attempt from using a `write` attempt's token on that machine; [#231](https://github.com/basaltbytes/usine/issues/231) and [#243](https://github.com/basaltbytes/usine/issues/243) track the fix, a Unix user or machine per attempt. A `read` checkout gets a pre-push hook that stops `git push` with a message naming the loop and level. It isn't a control (`--no-verify` skips it); it explains the failure better than GitHub's 403. Unsuccessful `read` attempts leave no salvage branch: they had nothing to change and can't push.

The level is recorded with the event on match, like the agent and task, so a run keeps its opening level.

exe.dev's integration grants the access of exe.dev's own App and can't be narrowed per attempt, so exe.dev workers refuse `read` loop attempts before attaching it, with a `credentials` capability error naming the worker and loop. A push-capable token behind only the hook would make `permissions: read` meaningless there.
