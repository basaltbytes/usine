# @usine/web

The usine web UI, served by `@usine/server`. Internal — never published.

The first screen lists registered projects and marks those with Items that need intervention. A project opens as a horizontal Board whose authored or proposed lanes group the latest GitHub issues and pull requests. Cards show labels, the latest Run's agent and state, and any approval or error that needs the operator. Label-backed lanes accept drag-and-drop moves; state-only and unmatched lanes are read-only.

Clicking a card with a Run opens the live protocol transcript drawer. Parent messages stay inline; each child session's activity is grouped into its own collapsible level, and truncated Attempts expose a load-earlier control until their full history is reachable. The separate Configuration view contains database-backed Loop pause controls. Needs-setup mode states that newly supplied GitHub App credentials require restarting `usine up` because the running process reads them only at startup.

The app uses React, TypeScript, TanStack Query, and TanStack Router, with hand-written CSS. Its visual system follows ADR 0015: Catppuccin Mocha tokens, Archivo signage, IBM Plex Mono annotations, a modular type scale, and restrained rules.
