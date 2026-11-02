# Pele diagrams

Chromium checks at 1440 × 1000 and 390 × 1000 covered every published page with a diagram in light and dark themes. Captures show the diagram frame at its initial horizontal scroll position. Wide diagrams retain their measured size and scroll inside the frame with touch, a pointer, or the keyboard.

| Page | Desktop, light | Desktop, dark | Mobile, light | Mobile, dark |
| --- | --- | --- | --- | --- |
| Concepts | [Capture](concepts-desktop-light.png) | [Capture](concepts-desktop-dark.png) | [Capture](concepts-mobile-light.png) | [Capture](concepts-mobile-dark.png) |
| Add a worker | [Capture](add-a-worker-desktop-light.png) | [Capture](add-a-worker-desktop-dark.png) | [Capture](add-a-worker-mobile-light.png) | [Capture](add-a-worker-mobile-dark.png) |
| Operate runs | [Capture](operate-runs-desktop-light.png) | [Capture](operate-runs-desktop-dark.png) | [Capture](operate-runs-mobile-light.png) | [Capture](operate-runs-mobile-dark.png) |
| Write a loop | [Capture](write-a-loop-desktop-light.png) | [Capture](write-a-loop-desktop-dark.png) | [Capture](write-a-loop-mobile-light.png) | [Capture](write-a-loop-mobile-dark.png) |
| usine.yaml | [Capture](usine-yaml-desktop-light.png) | [Capture](usine-yaml-desktop-dark.png) | [Capture](usine-yaml-mobile-light.png) | [Capture](usine-yaml-mobile-dark.png) |

Complete diagrams: [light](complete-light.png) and [dark](complete-dark.png).

## Results

The Concepts SVG is 525 pixels wide. Its Configuration, Instance, and Project titles have separate bounds; node labels render at 16 pixels and edge labels at 14 pixels. Its page width remains 390 pixels on mobile. Every published diagram retains its intrinsic SVG width at both viewports, and ArrowRight scrolls frames that overflow. Hiding every diagram leaves each page's width unchanged.

At 390 pixels, the Add a worker page has a 476-pixel document width and Operate runs has a 401-pixel document width because their pagination links overflow. These widths remain the same with every diagram hidden. Their diagram frames are 340 pixels wide and contain their own overflow.

Two diagram sources changed for Pele:

- Concepts: the Execution group flows vertically to fit the desktop reading column at its measured label size.
- Operate runs: line breaks separate the failure and retry labels beside the Failed state.

The other published sources retain their syntax. Pele lays them out for a 600-pixel reading area before the CSS frame handles any remaining overflow.

## Architecture sources

The 25 diagrams in `docs/architecture/` are contributor notes outside the published site. All parse with Pele and were checked in a temporary gallery using the site's diagram styles at both viewports and in both themes. Their sources are unchanged.

| File | Diagrams |
| --- | --- |
| `execution.mdx` | 3 |
| `index.mdx` | 4 |
| `loops-shipped.md` | 1 |
| `operator-surfaces.mdx` | 1 |
| `run-lifecycle.mdx` | 5 |
| `storage-and-config.mdx` | 2 |
| `workers-and-gateway.mdx` | 9 |

## Build checks

The docs build runs `test/diagrams.test.ts` to render every Mermaid fence in the published content through the rehype plugin. Separate invalid Markdown and MDX build probes both failed with the page path and Pele parse error. Inspection of the 11 built JavaScript files found no Mermaid.js or Pele renderer code.

To inspect the pages locally, run `pnpm --filter @usine/docs build`, then `pnpm --filter @usine/docs preview`. Switch the site's theme and inspect the five pages at each viewport width.
