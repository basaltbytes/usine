# Command palette selection

Chromium captures of the command palette browser fixture at 1440 × 900 (desktop), in dark and light themes. The palette is open with an empty search, and ArrowDown has moved the selection from **Overview** to **Configuration · Loops**, the second item.

| Screen | Desktop, dark | Desktop, light |
| --- | --- | --- |
| Command palette with the second item selected | [Capture](palette-desktop-dark.png) | [Capture](palette-desktop-light.png) |

To regenerate from the repository root:

```sh
pnpm --filter @usine/web exec vitest run src/components/command-palette/palette.browser.test.tsx
```

The test writes `765-*.png` files to `.impeccable/review/`. Copy them here without the `765-` prefix. It checks that only the selected item has `data-selected="true"` and that every other item has `data-selected="false"`.
