# Configuration screens

Browser captures for issue #962 use representative configuration fixtures. Desktop captures use 1440 × 900; phone captures use 390 × 900. Each screen appears in dark and light themes. Long forms scroll inside the work panel.

Entity detail pages link to History from the heading. Form captures show the shared field width and controls. The filtered History captures include an expanded revision and the permitted Revert action.

| Screen | Desktop dark | Desktop light | Phone dark | Phone light |
| --- | --- | --- | --- | --- |
| Agents | [desktop dark](agents-desktop-dark.png) | [desktop light](agents-desktop-light.png) | [phone dark](agents-phone-dark.png) | [phone light](agents-phone-light.png) |
| Agents detail | [desktop dark](agents-detail-desktop-dark.png) | [desktop light](agents-detail-desktop-light.png) | [phone dark](agents-detail-phone-dark.png) | [phone light](agents-detail-phone-light.png) |
| Agents form | [desktop dark](agents-form-desktop-dark.png) | [desktop light](agents-form-desktop-light.png) | [phone dark](agents-form-phone-dark.png) | [phone light](agents-form-phone-light.png) |
| Role bindings | [desktop dark](bindings-desktop-dark.png) | [desktop light](bindings-desktop-light.png) | [phone dark](bindings-phone-dark.png) | [phone light](bindings-phone-light.png) |
| Role bindings detail | [desktop dark](bindings-detail-desktop-dark.png) | [desktop light](bindings-detail-desktop-light.png) | [phone dark](bindings-detail-phone-dark.png) | [phone light](bindings-detail-phone-light.png) |
| Role bindings form | [desktop dark](bindings-form-desktop-dark.png) | [desktop light](bindings-form-desktop-light.png) | [phone dark](bindings-form-phone-dark.png) | [phone light](bindings-form-phone-light.png) |
| History | [desktop dark](history-desktop-dark.png) | [desktop light](history-desktop-light.png) | [phone dark](history-phone-dark.png) | [phone light](history-phone-light.png) |
| Filtered History | [desktop dark](history-filtered-desktop-dark.png) | [desktop light](history-filtered-desktop-light.png) | [phone dark](history-filtered-phone-dark.png) | [phone light](history-filtered-phone-light.png) |
| Labels | [desktop dark](labels-desktop-dark.png) | [desktop light](labels-desktop-light.png) | [phone dark](labels-phone-dark.png) | [phone light](labels-phone-light.png) |
| Labels detail | [desktop dark](labels-detail-desktop-dark.png) | [desktop light](labels-detail-desktop-light.png) | [phone dark](labels-detail-phone-dark.png) | [phone light](labels-detail-phone-light.png) |
| Labels form | [desktop dark](labels-form-desktop-dark.png) | [desktop light](labels-form-desktop-light.png) | [phone dark](labels-form-phone-dark.png) | [phone light](labels-form-phone-light.png) |
| Loops | [desktop dark](loops-desktop-dark.png) | [desktop light](loops-desktop-light.png) | [phone dark](loops-phone-dark.png) | [phone light](loops-phone-light.png) |
| Loops detail | [desktop dark](loops-detail-desktop-dark.png) | [desktop light](loops-detail-desktop-light.png) | [phone dark](loops-detail-phone-dark.png) | [phone light](loops-detail-phone-light.png) |
| Loops form | [desktop dark](loops-form-desktop-dark.png) | [desktop light](loops-form-desktop-light.png) | [phone dark](loops-form-phone-dark.png) | [phone light](loops-form-phone-light.png) |
| Projects | [desktop dark](projects-desktop-dark.png) | [desktop light](projects-desktop-light.png) | [phone dark](projects-phone-dark.png) | [phone light](projects-phone-light.png) |
| Projects detail | [desktop dark](projects-detail-desktop-dark.png) | [desktop light](projects-detail-desktop-light.png) | [phone dark](projects-detail-phone-dark.png) | [phone light](projects-detail-phone-light.png) |
| Projects form | [desktop dark](projects-form-desktop-dark.png) | [desktop light](projects-form-desktop-light.png) | [phone dark](projects-form-phone-dark.png) | [phone light](projects-form-phone-light.png) |
| Repositories | [desktop dark](repositories-desktop-dark.png) | [desktop light](repositories-desktop-light.png) | [phone dark](repositories-phone-dark.png) | [phone light](repositories-phone-light.png) |
| Repositories detail | [desktop dark](repositories-detail-desktop-dark.png) | [desktop light](repositories-detail-desktop-light.png) | [phone dark](repositories-detail-phone-dark.png) | [phone light](repositories-detail-phone-light.png) |
| Repositories form | [desktop dark](repositories-form-desktop-dark.png) | [desktop light](repositories-form-desktop-light.png) | [phone dark](repositories-form-phone-dark.png) | [phone light](repositories-form-phone-light.png) |
| Settings detail | [desktop dark](settings-detail-desktop-dark.png) | [desktop light](settings-detail-desktop-light.png) | [phone dark](settings-detail-phone-dark.png) | [phone light](settings-detail-phone-light.png) |
| Settings form | [desktop dark](settings-form-desktop-dark.png) | [desktop light](settings-form-desktop-light.png) | [phone dark](settings-form-phone-dark.png) | [phone light](settings-form-phone-light.png) |
| Workers | [desktop dark](workers-desktop-dark.png) | [desktop light](workers-desktop-light.png) | [phone dark](workers-phone-dark.png) | [phone light](workers-phone-light.png) |
| Workers detail | [desktop dark](workers-detail-desktop-dark.png) | [desktop light](workers-detail-desktop-light.png) | [phone dark](workers-detail-phone-dark.png) | [phone light](workers-detail-phone-light.png) |
| Workers form | [desktop dark](workers-form-desktop-dark.png) | [desktop light](workers-form-desktop-light.png) | [phone dark](workers-form-phone-dark.png) | [phone light](workers-form-phone-light.png) |

Regenerate with `pnpm --filter @usine/web exec vitest run src/features/configuration/components/editor/history/history.browser.test.tsx`. The browser command writes captures to `.impeccable/review/962-*.png`; copy them here without the `962-` filename prefix.
