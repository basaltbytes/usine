# Role binding forms

Chromium captures at 1440 × 900 (desktop) and 390 × 900 (phone), in dark and light themes. The fixture uses synthetic members, a configured project, and an imported binding for an unenrolled member.

| Screen | Desktop, dark | Desktop, light | Phone, dark | Phone, light |
| --- | --- | --- | --- | --- |
| Members and binding links | [Capture](members-desktop-dark.png) | [Capture](members-desktop-light.png) | [Capture](members-phone-dark.png) | [Capture](members-phone-light.png) |
| New binding with member preselected | [Capture](new-binding-desktop-dark.png) | [Capture](new-binding-desktop-light.png) | [Capture](new-binding-phone-dark.png) | [Capture](new-binding-phone-light.png) |
| Project binding | [Capture](project-binding-desktop-dark.png) | [Capture](project-binding-desktop-light.png) | [Capture](project-binding-phone-dark.png) | [Capture](project-binding-phone-light.png) |
| Instance admin binding | [Capture](instance-binding-desktop-dark.png) | [Capture](instance-binding-desktop-light.png) | [Capture](instance-binding-phone-dark.png) | [Capture](instance-binding-phone-light.png) |

To regenerate from the repository root:

```sh
pnpm turbo run build --filter=@usine/config
pnpm --filter @usine/web exec vitest run src/features/configuration/components/forms/binding/fields.browser.test.tsx
```

The test writes `810-*.png` files to `.impeccable/review/`. Copy them here without the `810-` prefix. It covers creating, editing, and deleting a binding; member preselection; field errors; form and text switching; scope and role changes; and revision attribution in the browser. A server test in `apps/server/test/configuration-http/configuration.test.ts` verifies attribution through configuration writes and stored history. Phone captures use an emulated viewport in Chromium.
