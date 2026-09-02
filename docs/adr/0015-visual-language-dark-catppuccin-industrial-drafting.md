# The UI's visual language: dark Catppuccin, industrial-drafting graft

The structure was settled ([ADR 0008](./0008-web-ui-projects-kanban-spine.md)); the look was not — the #12 prototype's utilitarian dark-console styling was explicitly rejected. Five prototyped treatments later (industrial light, soft product, technical drawing, warm editorial dark, and an operator-directed graft), the operator picked the graft: **dark ground on the Catppuccin Mocha palette, industrial signage typography (Archivo caps for structure labels) crossed with technical-drawing discipline (drafting rules, IBM Plex Mono annotations), flat ruled rows and sections in place of nested boxed cards, high figure-ground contrast**. The dark-console rejection was about craft, not darkness — a dark UI with real typographic and line discipline is what the operator wants to live in.

## Consequences

- **The prototype is directional, not the reference.** The operator's acceptance is of the *idea*, with explicit refinement demands the implementation must honor: a real modular type scale (prototype sizes are "all over the place"), far fewer hard rules (rule every boundary and nothing reads), bounded line lengths instead of full-viewport rows (full-width info is hard to scan), and smaller structural labels. Implementing straight from the prototype file is the one forbidden move.
- The hazard-stripe "andon" motif is rejected — no factory-costume ornamentation; the language is carried by palette, type, and line discipline alone.
- Catppuccin Mocha is the token source (base/crust/surface neutrals, peach as the accent, red/yellow/green/blue for run states); state colors stay semantic, not decorative.
- Light mode is out of scope for v1 — the language is designed dark-first; nothing precludes a Latte counterpart later since colors enter as tokens.
- Prototype (five skins, switchable) lives on the `prototype/ui-visual-language` branch as the primary source of the exploration.

## Amendment (2026-09-02, #78)

The token and component source moved to the shadcn registry: a preset generated in `apps/web/components.json` supplies the neutrals, radii, and type (Geist for text, Geist Mono for headings and identifiers), with the dark `foreground`, `primary`, and `secondary` tokens pulled to Catppuccin Mocha text, mauve, and surface0. Archivo and IBM Plex Mono are gone; the palette, dark-first stance, flat ruled sections, and semantic run-state colors stand. `apps/web/README.md` carries the working rules.
