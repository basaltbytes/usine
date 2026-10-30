# GitHub App setup

Chromium captures at 1440 × 900 (desktop) and 390 × 844 (phone), in dark and light themes. The browser fixtures use fake GitHub manifest, installation, and sign-in responses. The repository picker starts with an empty registry and offers repositories from the fake installation.

| Screen | Desktop, dark | Desktop, light | Phone, dark | Phone, light |
| --- | --- | --- | --- | --- |
| No App credentials | [Capture](no-app-desktop-dark.png) | [Capture](no-app-desktop-light.png) | [Capture](no-app-phone-dark.png) | [Capture](no-app-phone-light.png) |
| Credential recovery | [Capture](missing-key-desktop-dark.png) | [Capture](missing-key-desktop-light.png) | [Capture](missing-key-phone-dark.png) | [Capture](missing-key-phone-light.png) |
| App created, awaiting installation | [Capture](no-installation-desktop-dark.png) | [Capture](no-installation-desktop-light.png) | [Capture](no-installation-phone-dark.png) | [Capture](no-installation-phone-light.png) |
| Installation connected, first-admin sign-in required | [Capture](empty-registry-desktop-dark.png) | [Capture](empty-registry-desktop-light.png) | [Capture](empty-registry-phone-dark.png) | [Capture](empty-registry-phone-light.png) |
| Signed in, ready to add repositories | [Capture](repository-handoff-desktop-dark.png) | [Capture](repository-handoff-desktop-light.png) | [Capture](repository-handoff-phone-dark.png) | [Capture](repository-handoff-phone-light.png) |
| Installation repository picker | [Capture](repository-picker-desktop-dark.png) | [Capture](repository-picker-desktop-light.png) | [Capture](repository-picker-phone-dark.png) | [Capture](repository-picker-phone-light.png) |
| First-member sign-in page | [Capture](sign-in-desktop-dark.png) | [Capture](sign-in-desktop-light.png) | [Capture](sign-in-phone-dark.png) | [Capture](sign-in-phone-light.png) |

To regenerate from the repository root:

```sh
pnpm exec turbo run build --filter='@usine/web^...'
pnpm --filter @usine/web exec vitest run src/features/setup/setup.page.browser.test.tsx src/features/sign-in/sign-in.page.browser.test.tsx src/features/configuration/components/repositories/list.browser.test.tsx
```

The tests write `779-*.png` files to `.impeccable/review/`. Copy them here without the `779-` prefix. They check setup transitions, recovery, GitHub links, runtime readiness, installation repository selection, and horizontal overflow. Phone captures use an emulated Chromium viewport. Credential recovery uses a full-page capture to include the expanded form.
