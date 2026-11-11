# Releasing

[Changesets](https://github.com/changesets/changesets) handles releases: add a changeset for each user-visible change. CI opens a **Version Packages** PR. Merging it stages the changed versions for npm's `latest` dist-tag; an npm maintainer approves them before they become installable. 0.x APIs change without notice.

The repository pins pnpm 11.20.0, which supports [`pnpm stage`](https://pnpm.io/11.x/cli/stage) and OIDC trusted publishing. The `release` job uses `pnpm stage publish -r --tag latest --no-git-checks`. The `next` job runs `pnpm prerelease:publish <run number> <commit sha> <run attempt>` to publish snapshots directly with provenance, so keep **Allow npm publish** enabled on every `@usine` trusted publisher. Both jobs use `release.yml`, the workflow registered with npm.

## Approval

After the Version Packages release job succeeds, use a local npm account with publish access and 2FA enabled:

```sh
pnpm stage list
pnpm stage view <stage-id>
pnpm stage approve <stage-id> --otp <code>
```

Review the package name, version, and source commit before approving each stage ID from the release job's output. Approve workspace dependencies before their dependents. You can also review and approve versions in the **Staged Packages** tab on npmjs.com. Approve every package in the release before continuing.

Check that the new version is public and that `latest` points to it. For example, for `@usine/core`:

```sh
curl --fail --silent --show-error https://registry.npmjs.org/@usine%2fcore | jq '."dist-tags".latest'
pnpm view @usine/core@<version> version
```

Rerun only the `release` job of the original Version Packages workflow run. Use `gh run view <run-id> --json jobs` to find its database ID, then:

```sh
gh run rerun <run-id> --job <release-job-id>
gh run watch <run-id> --exit-status
```

The rerun skips versions that npm already exposes. The tag step checks every publishable workspace version against the public npm registry before running `changeset git-tag`; Changesets then pushes the tags and creates GitHub releases. A pending approval skips all tags and releases, and a registry error fails the job. Rerunning the original job preserves the source commit. GitHub also reruns dependent jobs; `next` publishes a fresh snapshot for each job rerun. Do not run `changeset git-tag` directly or dispatch a new release at a newer commit to finalize an older release.

If a release fails after staging some packages, inspect its stage IDs and approve the valid artifacts before retrying that job. Use `pnpm stage reject <stage-id> --otp <code>` for artifacts that need replacement. The retry stages any versions that are still absent from the public registry; repeat approval and rerun until all versions are public and the GitHub releases exist.

If the `usine` npm org is unavailable, ADR 0012 moves every package to the `@usine-dev` scope. The unscoped `usine` name belongs to an unrelated, unmaintained package.

## Snapshot publish retries

Each snapshot uses a version such as `0.4.1-next.312.g1a2b3c4.1.2`: workflow run 312, commit `1a2b3c4`, job run attempt 1, and publish attempt 2. The `next` job retries Sigstore transparency-log 409s and previously staged-version conflicts up to three publish attempts, waiting 15 and 30 seconds before retrying. Each retry versions and rebuilds every published package from the original manifests so workspace dependencies refer to the same snapshot. Provenance remains required on every publish.

After an upload succeeds, the job checks every snapshot version on the public registry for up to ten minutes. It waits 10 seconds after the first check and 5 seconds longer after each later check, up to 30 seconds. The job never republishes a successful upload. If versions are still unavailable after ten minutes, npm has accepted them but does not serve them yet: the job logs `next_publish_slow` with the pending versions, adds a warning annotation and a step summary that name them, and succeeds. Check them later with `pnpm view <package>@<version> version`. Registry errors, unrelated publish errors, and build errors fail the job immediately. Logs report the snapshot versions, retry reason, delay, and final outcome.

Retries use fresh versions because a staged version is occupied but absent from public registry metadata. npm requires interactive authentication to approve or reject it; the job's OIDC credentials cannot perform those operations. Failed attempts can leave partial or staged snapshots. An npm maintainer can inspect and reject abandoned stage IDs with the commands above. This retry policy applies to `next`; stable releases keep the approval procedure above.

## Prereleases

The `next` job of the release workflow publishes `main` under the `next` dist-tag. It runs only when someone starts the workflow, so a prerelease collects several merged changes:

```sh
gh workflow run release.yml --ref main
```

The dogfood instance upgrades from `next`. Start the workflow before an instance upgrade, not after each merge.
