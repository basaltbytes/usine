# @usine/docs

The usine documentation site, built with [Astro Starlight](https://starlight.astro.build) and the [Lucode theme](https://lucas-labs.github.io/lucode-starlight-theme/). Internal — never published.

```sh
pnpm --filter @usine/docs dev      # local server with reload
pnpm --filter @usine/docs build    # static site in dist/
pnpm --filter @usine/docs preview  # serve dist/
pnpm --filter @usine/docs check    # astro check: types and frontmatter
```

Pages are Markdown or MDX files under `src/content/docs/`. Each top-level folder (`guides/`, `architecture/`, `reference/`) is a sidebar group that lists its pages automatically; set `sidebar.order` in a page's frontmatter to place it. Link to other pages by route, such as `/architecture/run-lifecycle/`.

A fenced `mermaid` code block renders as a diagram in the browser and follows the light or dark theme.
