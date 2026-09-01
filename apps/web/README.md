# @usine/web

The usine web UI, served by `@usine/server`. Internal — never published.

The first screen is the local observe-and-intervene surface: projects and recent Runs, a needs-you strip, database-backed Loop pause controls, and a Run drawer with live protocol transcripts. Parent messages stay inline; each child session's activity is grouped into its own collapsible level, and truncated Attempts expose a load-earlier control until their full history is reachable. The app turns the orchestrator's structured transcript and need variants into operator-facing copy. Needs-setup mode states that newly supplied GitHub App credentials require restarting `usine up` because the running process reads them only at startup.

The app uses React, TypeScript, TanStack Query, and TanStack Router, with hand-written CSS. Its visual system follows ADR 0015: Catppuccin Mocha tokens, Archivo signage, IBM Plex Mono annotations, a modular type scale, and restrained rules.
