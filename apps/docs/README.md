# @usine/docs

The documentation site uses [Astro Starlight](https://starlight.astro.build) and the Lucode theme. Cloudflare serves the static build at <https://docs.usine.dev>.

## Build and preview

From the repository root, install dependencies with `pnpm install --frozen-lockfile`, then build workspace dependencies:

```sh
pnpm turbo run build --filter=@usine/docs^...
pnpm --filter @usine/docs build
pnpm --filter @usine/docs preview
```

Use `pnpm --filter @usine/docs dev` for a development server. `pnpm --filter @usine/docs check` synchronizes content types and checks TypeScript. The build tests configuration examples and diagrams, generates OpenAPI, and validates page and heading links.

## Writing rules

Pages are under `src/content/docs/`. Use Google developer documentation style and the glossary in `CONTEXT.md`. Describe supported behavior in the present tense; keep issue references, ADR citations, migration history, and compatibility windows out of product pages.

Each guide covers one task: goal, prerequisites, numbered steps, and a result check. Reference tables give each entity or command's types, defaults, and field descriptions, followed by examples. Describe stored configuration and its UI or CLI edits; keep file syntax in the import and export reference and quickstart.

Link to site routes, such as `/guides/follow-a-run/`. Update `astro.config.mjs` for navigation and `redirects.mjs` when replacing a route. Fenced Mermaid diagrams follow the site theme. Contributor architecture notes belong in `docs/architecture/` outside the site.

A fenced `mermaid` code block renders to SVG at build time with [Pele](https://pele.run/). The rehype plugin in `diagrams/rehype.mjs` runs for Markdown and MDX through Astro's unified processor. Invalid diagrams fail the build with the page path, fence position, and Pele error. Diagram colors use Starlight theme tokens through `--pele-*` variables in `src/styles/diagrams.css`, so switching themes updates the SVG through CSS.

Diagrams retain their measured label sizes. Wide diagrams scroll inside a keyboard-focusable frame, including on mobile. Prefer vertical layouts when a horizontal diagram would require extensive scrolling. `test/diagrams.test.ts` renders every diagram page in `src/content/docs/` through the same plugin during the docs build; it also checks parse failures and distinct SVG reference IDs for pages with multiple diagrams.

`node scripts/docs/check.mjs` checks every Markdown and MDX page for issue references and historical wording. The root `pnpm check` runs it, and `pnpm test` tests rejection with fixture pages. Quickstart files in `quickstart/` are imported directly by the quickstart page; edit them instead of duplicating examples. Their parser tests run in the docs build.

## OpenAPI

The operator API page renders the committed `public/openapi.json`. After changing an API contract, regenerate and check it:

```sh
pnpm turbo run build --filter=@usine/docs^...
pnpm --filter @usine/docs openapi:generate
pnpm --filter @usine/docs openapi:check
```

Commit the JSON with the contract change. The root gate checks both generated content and its Git diff so a build cannot hide stale output. Download the published schema at `/openapi.json`, or request `/api/openapi.json` from a running instance.

## Deploy

The `Deploy docs` workflow builds and deploys relevant pushes to `main` using the `CLOUDFLARE_API_TOKEN` repository secret. For a manual deployment, build first, authenticate Wrangler, and deploy the existing `dist/`:

```sh
pnpm turbo run build --filter=@usine/docs
pnpm --filter @usine/docs exec wrangler login
pnpm --filter @usine/docs run deploy
```

`wrangler.jsonc` configures the `usine-docs` Worker and custom domain.
