# Guide navigation and instance setup

Chromium captures of the built documentation site at 1440 × 1000 (desktop) and 390 × 844 (mobile), with light and dark themes. The guide captures include the full page; mobile sidebar captures show the open navigation menu scrolled to Guides.

| Page | Desktop, light | Desktop, dark | Mobile, light | Mobile, dark |
| --- | --- | --- | --- | --- |
| Sidebar | [Capture](sidebar-desktop-light.png) | [Capture](sidebar-desktop-dark.png) | [Capture](sidebar-mobile-light.png) | [Capture](sidebar-mobile-dark.png) |
| Run usine locally | [Capture](run-usine-locally-desktop-light.png) | [Capture](run-usine-locally-desktop-dark.png) | [Capture](run-usine-locally-mobile-light.png) | [Capture](run-usine-locally-mobile-dark.png) |
| Host usine on a Linux server | [Capture](host-usine-on-linux-desktop-light.png) | [Capture](host-usine-on-linux-desktop-dark.png) | [Capture](host-usine-on-linux-mobile-light.png) | [Capture](host-usine-on-linux-mobile-dark.png) |

Build with `pnpm --filter @usine/docs build` and serve with `pnpm --filter @usine/docs preview`. Open `/guides/overview/`, `/guides/run-usine-locally/`, and `/guides/host-usine-on-linux/` at each viewport and select each theme. On the overview page, open and close each task group to check its control before capturing the collapsed groups. Both guides fit the viewport without horizontal page scrolling; code blocks scroll within their frames.
