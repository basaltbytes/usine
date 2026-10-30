# On-demand worker preflight

Chromium captures of the workers browser fixture at 1440 × 900 (desktop) and 390 × 844 (phone), in dark and light themes. The fixture runs preflight on `eu-1`, returns an unreachable SSH destination with remediation, then passes after a second run without restarting.

| Screen | Desktop, dark | Desktop, light | Phone, dark | Phone, light |
| --- | --- | --- | --- | --- |
| Workers page with Run preflight | [Capture](workers-desktop-dark.png) | [Capture](workers-desktop-light.png) | [Capture](workers-phone-dark.png) | [Capture](workers-phone-light.png) |
| Running preflight | [Capture](running-desktop-dark.png) | [Capture](running-desktop-light.png) | [Capture](running-phone-dark.png) | [Capture](running-phone-light.png) |
| Failed capability and remediation | [Capture](failed-desktop-dark.png) | [Capture](failed-desktop-light.png) | [Capture](failed-phone-dark.png) | [Capture](failed-phone-light.png) |
| Passed after the second run | [Capture](passed-desktop-dark.png) | [Capture](passed-desktop-light.png) | [Capture](passed-phone-dark.png) | [Capture](passed-phone-light.png) |

To regenerate from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter='@usine/orchestrator...'
pnpm --filter @usine/web exec playwright install chromium
pnpm --filter @usine/web exec vitest run src/features/configuration/components/workers/list.browser.test.tsx
for capture in .impeccable/review/773-*.png; do
  name=${capture##*/773-}
  cp "$capture" "docs/screenshots/773/$name"
done
```

Workers that set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` use that Chromium executable. The test writes `773-*.png` files to `.impeccable/review/` and checks the request, progress, refreshed checks, remediation, repair, and horizontal overflow. Separate cases cover disabled actions and server refusals. Phone captures use an emulated viewport in Chromium; detail captures scroll to the Preflight section.
