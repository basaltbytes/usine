# Project boards and configuration

Chromium captures of browser-test fixtures at 1440 × 900 (desktop) and 390 × 900 (phone).

| Screen | Desktop, dark | Desktop, light | Phone, dark | Phone, light |
| --- | --- | --- | --- | --- |
| Two-repository board | [Capture](board-desktop-dark.png) | [Capture](board-desktop-light.png) | [Capture](board-phone-dark.png) | [Capture](board-phone-light.png) |
| Task list | [Capture](tasks-desktop-dark.png) | [Capture](tasks-desktop-light.png) | [Capture](tasks-phone-dark.png) | [Capture](tasks-phone-light.png) |
| Project form with lanes | [Capture](project-form-desktop-dark.png) | [Capture](project-form-desktop-light.png) | [Capture](project-form-phone-dark.png) | [Capture](project-form-phone-light.png) |

To regenerate, run from the repository root:

```sh
pnpm --filter @usine/web exec vitest run src/features/projects/multi-repository.browser.test.tsx src/features/configuration/components/editor/entity.browser.test.tsx
```

The tests write `673-*.png` files to `.impeccable/review/`.
