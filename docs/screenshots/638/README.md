# Cloud quota refusals

Chromium captures of the quota browser fixture at 1440 × 900 (desktop) and 390 × 900 (phone), in dark and light themes. The fixture uses a Hetzner shared-core quota refusal on `hetzner-pool` and a run waiting for that worker to create a machine.

| Screen | Desktop, dark | Desktop, light | Phone, dark | Phone, light |
| --- | --- | --- | --- | --- |
| Needs attention entry | [Capture](attention-desktop-dark.png) | [Capture](attention-desktop-light.png) | [Capture](attention-phone-dark.png) | [Capture](attention-phone-light.png) |
| Recovery steps from the entry’s Details menu | [Capture](recovery-desktop-dark.png) | [Capture](recovery-desktop-light.png) | [Capture](recovery-phone-dark.png) | [Capture](recovery-phone-light.png) |
| Board card | [Capture](board-desktop-dark.png) | [Capture](board-desktop-light.png) | [Capture](board-phone-dark.png) | [Capture](board-phone-light.png) |
| Run page | [Capture](run-desktop-dark.png) | [Capture](run-desktop-light.png) | [Capture](run-phone-dark.png) | [Capture](run-phone-light.png) |

To regenerate from the repository root:

```sh
pnpm --filter @usine/web exec vitest run src/components/needs-you/worker-quota-ask.browser.test.tsx
```

The test writes `638-*.png` files to `.impeccable/review/`. Copy them here without the `638-` prefix. It checks recovery text wrapping, keyboard dismissal and focus restoration, notification tray access, and waiting reasons on the board and run page. Phone captures use an emulated viewport in Chromium.
