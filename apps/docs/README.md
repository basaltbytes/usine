# @usine/docs

The usine documentation site, built with [Astro Starlight](https://starlight.astro.build) and the [Lucode theme](https://lucas-labs.github.io/lucode-starlight-theme/). It isn't published to npm. It's deployed to <https://docs.usine.dev> as the `usine-docs` Worker on the Basaltbytes Cloudflare account.

```sh
pnpm --filter @usine/docs dev         # local server with reload
pnpm --filter @usine/docs build       # static site in dist/
pnpm --filter @usine/docs preview     # serve dist/
pnpm --filter @usine/docs check       # astro check: types and frontmatter
pnpm --filter @usine/docs run deploy  # upload dist/ to docs.usine.dev
```

Pages are Markdown or MDX files under `src/content/docs/`. The `guides/`, `architecture/`, and `reference/configuration/` folders are sidebar groups that list their pages automatically; set `sidebar.order` in a page's frontmatter to place it. Link to other pages by route, such as `/architecture/run-lifecycle/`. The build fails on a link to a page or heading that doesn't exist.

TypeDoc generates `reference/api/` on every `build`, `dev`, and `check`, from the declaration files of the public subpaths of each `@usine/*` package in this package's `devDependencies`. It isn't committed. Build those packages first: `pnpm build` from the repository root does, or `pnpm turbo run build --filter=@usine/docs^...` before `dev`. `typedoc-package-modules.mjs` sets the page structure: one page per package and one per subpath.

A fenced `mermaid` code block renders as a diagram in the browser and follows the light or dark theme.

`wrangler.jsonc` configures the Worker to serve `dist/` as static assets on the `docs.usine.dev` custom domain, with no Worker script. The `Deploy docs` workflow (`.github/workflows/deploy-docs.yml`) builds and deploys the site on every push to `main`, with the `CLOUDFLARE_API_TOKEN` repository secret. To deploy by hand, run `pnpm turbo run build --filter=@usine/docs` first, because `deploy` uploads whatever is in `dist/`. Wrangler needs a login to the Basaltbytes account (`npx wrangler login`).
