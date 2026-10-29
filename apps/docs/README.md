# @usine/docs

The usine documentation site, built with [Astro Starlight](https://starlight.astro.build) and the [Lucode theme](https://lucas-labs.github.io/lucode-starlight-theme/). It isn't on npm. It's deployed to <https://docs.usine.dev> as the `usine-docs` Worker on the Basaltbytes Cloudflare account.

```sh
pnpm --filter @usine/docs dev         # local server with reload
pnpm --filter @usine/docs build       # static site in dist/
pnpm --filter @usine/docs preview     # serve dist/
pnpm --filter @usine/docs check       # astro check: types and frontmatter
pnpm --filter @usine/docs run deploy  # upload dist/ to docs.usine.dev
```

Pages are Markdown or MDX files in `src/content/docs/`. The `guides/`, `architecture/`, and `reference/configuration/` folders are sidebar groups that list their pages automatically, ordered by each page's `sidebar.order`. Link to other pages by route, such as `/architecture/run-lifecycle/`. The build fails on a link to a page or heading that doesn't exist.

The [workers and gateway architecture page](src/content/docs/architecture/workers-and-gateway.mdx) describes gateway-held harness logins, caller tokens, and cleanup of attempt Codex homes.

The [Operate runs guide](src/content/docs/guides/operate-runs.md) documents saved agent definitions for Retry, current definitions for Edit and retry, cancellation of open runs, and failure-to-answer statistics for retries and resolutions.

The [review and fix loops guide](src/content/docs/guides/review-fix-loops.md) documents conflict findings for read-only reviewers, base-branch merges before pushing fixes, and CI checks before changing outcome labels.

The [server guide](src/content/docs/guides/run-the-orchestrator-on-a-server.mdx) documents npm channel upgrades, idle and immediate restarts, the independent rollback helper, and setup for existing systemd installations. The CLI and `usine.yaml` reference pages describe the corresponding command and settings.

TypeDoc generates `reference/api/` on every `build`, `dev`, and `check`, from the declaration files of the public subpaths of each `@usine/*` package in this package's `devDependencies`. The folder isn't committed. Build those packages first with `pnpm build` from the repository root, or `pnpm turbo run build --filter=@usine/docs^...` before `dev`. The TypeDoc plugin in `typedoc/` makes one page per package and per subpath, and shortens some Effect types; `typedoc/plugin.mjs` lists its changes.

A fenced `mermaid` code block renders as a diagram in the browser and follows the light or dark theme.

`wrangler.jsonc` makes the Worker serve `dist/` as static assets on the `docs.usine.dev` custom domain, with no Worker script. The `Deploy docs` workflow (`.github/workflows/deploy-docs.yml`) builds and deploys on every push to `main`, with the `CLOUDFLARE_API_TOKEN` repository secret. To deploy by hand, run `pnpm turbo run build --filter=@usine/docs` first, because `deploy` uploads `dist/` as it is, after `npx wrangler login` to the Basaltbytes account.

The worker reference documents provisioner timing settings in seconds, machine checks, and cleanup when a worker is removed. The execution architecture describes attempt persistence before machine creation.

The [worker guide](src/content/docs/guides/add-a-worker.mdx) describes shared pnpm and Turborepo volumes, Node.js 22 provisioning, and container limits derived from the host.
