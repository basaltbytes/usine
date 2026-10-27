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

## Amendment (2026-10-24, #242): the App's bot account authors every attempt's commits

On 2026-10-14, a finish-pr attempt on the local worker made commit 69d4da0 on PR #238 as the operator. The local worker passes `HOME`, so git read the operator's global config, and nothing else set an identity. An earlier finish-pr commit, b91afd0 on PR #232, had the bot identity only because its agent chose to pass `git -c user.name=... -c user.email=...`. Commits now follow the App identity like every other GitHub action: the scheduler puts the App's bot account in each `CheckoutRequest`, and every worker kind sets `GIT_AUTHOR_*` and `GIT_COMMITTER_*` in the parent's and children's environment, which git prefers to any config. On exe.dev, the integration's bot still pushes, and the App's bot authors.

The address is `<id>+<slug>[bot]@users.noreply.github.com`, the ID-based noreply form that GitHub links to an account even after a rename. The ID is the bot account's, read once from `GET /users/<slug>[bot]`. The App ID is a different number, and as an account ID it can belong to an unrelated user. An attempt whose bot account can't be read fails before preparation, retried unless GitHub refused, because without the variables its commits would take the machine's identity again.

Salvage commits and the rebase that applies a salvage use the same variables (#507). They had used `usine <usine@basaltbytes.dev>`, an identity linked to no GitHub account, so salvaged work showed no author profile and wasn't attributed to the App.

## Amendment (2026-10-25, #548): each attempt on an SSH worker runs in its own container

The 2026-10-19 amendment named the gap: attempts on an SSH worker share one Unix user, so an attempt could use another's token file, or behind a gateway its caller token, from the same machine, and a `read` attempt could push with a `write` attempt's token. File modes on `credentials/<attempt>` separate Unix users, not attempts. On an SSH worker whose machine has Docker, each attempt now runs in its own container, which mounts only its own checkout, credential directory, and harness logins: another attempt's token file isn't in its filesystem, and another attempt's processes, with their environment, aren't in its PID namespace. The token stays a single-repository installation token of at most an hour; the container changes who can read it, not what it opens.

A container per attempt was chosen over a Unix user per attempt or per slot, the fix that #243 proposed. Users per slot need accounts, sudo rules, and ownership changes on checkouts and cached clones made in advance, and resource limits set up apart; Docker gives a mount, PID, and resource boundary with one `docker run`, and the image pins the harness versions that cloud-init installed by hand. A machine per attempt (#223, stage 3) remains the stronger boundary, sharing no kernel.

Every command for the attempt runs in its container, the executor's git, salvage, and harvest included, because the checkout's git configuration and hooks are the agent's to change: run as the SSH user, which starts containers and so is root-equivalent through the `docker` group, they would run the agent's code outside the boundary. Only the fetch into the cached clone runs as the SSH user, and containers mount that clone read-only, so no attempt can change what the next one checks out. For the same reason, the checkout is a repository of its own that reads the clone's objects through an alternate, not a linked worktree whose git directory is inside the clone.

Which checkouts a container had is recorded in a file beside the worker's directories that no container mounts, written before the container starts. A reattachment or recovery reads that file, never the checkout: an attempt can rewrite its `.git`, and a checkout that looked like a linked worktree would otherwise make the SSH user run git with the attempt's hooks and configuration.

The harness login files are mounted read-write, as the shared user had them: the harnesses rewrite them when they refresh an OAuth token, and on the operator's subscriptions a refresh that can't be saved may leave every later attempt with a revoked login. An attempt can read and replace the operator's login, as before; the login lock still serializes Claude starts on the worker.

A machine without Docker runs attempts as the shared user, as before, and preflight reports the worker as degraded. A machine whose SSH user can use Docker never does: there, the shared user is root-equivalent ([ADR 0027](./0027-gateway-credential-proxy.md), amended 2026-10-25).

## Amendment (2026-10-26, #589): an instance ID tells apart instances that share the App

Attempt containers were labeled with `github-app-<App ID>` only, and each process removes the containers with that label that it didn't start. Two instance folders that share the App and a worker machine, such as a staging and a production instance, then removed each other's running containers at startup. The App stays the identity on GitHub. Each instance folder now also has an instance ID, a UUID that the first `usine up` writes to `.usine/instance-id` while it holds the instance lock, and that every later `usine up` reads. Each attempt container gets a `dev.usine.instance-id` label too, and a process removes only the containers that have both its labels.

The ID is a file in the gitignored `.usine/`, not a setting in `usine.yaml`, because two instances made from one published instance repo would share a setting. It moves and is backed up with the folder, which [ADR 0010](./0010-single-sqlite-runtime-store.md) says to copy whole. A deleted or changed file gives the instance a new ID, and usine then doesn't remove the containers that it left before, so a startup refuses a file that doesn't contain a UUID instead of replacing it.

A container that an earlier usine version left after a crash has no ID label, so no later process removes it; remove such containers with `docker rm` once. Provisioned machines and Cloudflare sandboxes still carry only the App's identity.

## Amendment (2026-10-27, #617): shared pnpm store on each worker machine

Attempt containers share the Docker volume `usine-pnpm-store` read-write at `/home/usine/.local/share/pnpm/store`, so later attempts on a long-lived worker reuse package downloads. This adds trusted shared package state to the mounts described above; checkout and credential directories remain scoped to each attempt. Worker entries and instances on the same Docker daemon share the volume. pnpm integrity checks do not provide isolation against an untrusted store writer.

Preflight requires the image's default user to match the SSH user's UID, initializes the volume with the image's `usine` UID, and logs its disk usage. An existing store owned by a different UID is refused with instructions to remove the volume. First use initializes the store on provisioned machines that skip the daily preflight; later attempts on the same machine reuse that preparation. Initialization changes only the volume root, and container removal preserves the volume. Operators reclaim it with `docker volume rm usine-pnpm-store` after removing containers that reference it; there is no automatic pruning. A provisioned machine deletes the volume after its one attempt. Turborepo's cache stays local to the container.
