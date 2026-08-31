# @usine/web

The usine web UI, served by `@usine/server`. Internal — never published.

The first screen is the local observe-and-intervene surface: projects and recent Runs, a needs-you strip, database-backed Loop pause controls, and a Run drawer with live protocol-v2 transcripts. Parent messages stay inline; child activity is grouped by `ChildSession.parentId` in a single collapsible level.

The app uses React, TypeScript, Tailwind, TanStack Query, and TanStack Router. Its visual system follows ADR 0015: Catppuccin Mocha tokens, Archivo signage, IBM Plex Mono annotations, a modular type scale, and restrained rules.
