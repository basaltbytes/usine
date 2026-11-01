# Roles and token scopes

Chromium captures of browser fixtures at 1440 × 900 (desktop) and 390 × 844 (phone), in dark and light themes. The fixtures include an instance admin, an operator and a viewer scoped to the `usine` project, and a member without bindings.

| Screen | Desktop, dark | Desktop, light | Phone, dark | Phone, light |
| --- | --- | --- | --- | --- |
| Instance admin binding editor | [Capture](instance-admin-desktop-dark.png) | [Capture](instance-admin-desktop-light.png) | [Capture](instance-admin-phone-dark.png) | [Capture](instance-admin-phone-light.png) |
| Project operator binding editor | [Capture](project-operator-desktop-dark.png) | [Capture](project-operator-desktop-light.png) | [Capture](project-operator-phone-dark.png) | [Capture](project-operator-phone-light.png) |
| Project viewer binding editor | [Capture](project-viewer-desktop-dark.png) | [Capture](project-viewer-desktop-light.png) | [Capture](project-viewer-phone-dark.png) | [Capture](project-viewer-phone-light.png) |
| Members with role bindings | [Capture](members-desktop-dark.png) | [Capture](members-desktop-light.png) | [Capture](members-phone-dark.png) | [Capture](members-phone-light.png) |
| Token creation with project scopes | [Capture](tokens-desktop-dark.png) | [Capture](tokens-desktop-light.png) | [Capture](tokens-phone-dark.png) | [Capture](tokens-phone-light.png) |
| Viewer run with actions hidden | [Capture](viewer-run-desktop-dark.png) | [Capture](viewer-run-desktop-light.png) | [Capture](viewer-run-phone-dark.png) | [Capture](viewer-run-phone-light.png) |

To regenerate from the repository root after installing dependencies and running `pnpm check`:

```sh
pnpm --filter @usine/web exec vitest run src/features/members/access.browser.test.tsx
```

The test writes `776-*.png` files to `.impeccable/review/`. Copy them here without the `776-` prefix. It checks binding links, members without bindings, token scope selection, and hidden viewer actions. Phone captures use an emulated Chromium viewport. The binding editor uses the configuration text format.
