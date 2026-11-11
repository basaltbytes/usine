# One GitHub App is the instance's identity; each attempt gets a single-repository token

usine acts on GitHub as one GitHub App that the operator owns, created by the manifest flow during setup and installed on the managed repositories. Polling, label writes, pushes, pull requests, comments, and commits all use it. Agents share the identity and sign their content (`— usine agent: <name>`), and the App's bot account is the author and committer of every attempt's commits, so no work is attributed to the machine's user. Only the orchestrator holds the App private key, and no attempt inherits the orchestrator's environment.

For each attempt, the orchestrator mints an installation token that expires within an hour and opens only the attempt's repository. A loop sets the token's level: `permissions: write`, the default, or `read`, which keeps `contents: read` so that GitHub refuses pushes while reviews, comments, and labels still work. A `read` checkout also gets a pre-push hook whose message names the loop; the token is the control, and the hook only explains the refusal. A gateway (ADR 0027) or Cloudflare's outbound handlers add the token to the attempt's GitHub requests; elsewhere, it is in a credential file for that attempt alone.

Write tokens include `workflows: write`, so agents can fix CI files. A leaked token still opens one repository for at most an hour.

The token limits an attempt only while the attempt can reach no other credential. On the `local` kind, an attempt runs as the operator's Unix user and can read that user's files. On an `ssh` machine without a container runtime, attempts share one user and can read each other's tokens, so a `read` attempt can use a `write` token (ADR 0029).

## Considered options

- **A fine-grained personal access token**: the agent's activity looks like the operator's, shares their rate limit, and lasts until revoked.
- **One App per agent**: real attribution and revocation, at the cost of setup and key custody per agent.
- **An installation-wide token on workers**: exposes every managed repository.
- **Per-scope permission lists in loops**: puts GitHub's permission model in loop files; two levels cover the cases.
- **Tokens without `workflows: write`**: a leaked token couldn't change CI, but CI-repair agents couldn't push workflow fixes.
