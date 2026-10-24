# The UI's visual language: dark Catppuccin, industrial-drafting graft

[ADR 0008](./0008-web-ui-projects-kanban-spine.md) set the structure, not the look: the #12 prototype's utilitarian dark-console styling was rejected. Of five prototyped treatments (industrial light, soft product, technical drawing, warm editorial dark, and an operator-directed graft), the graft won: **a dark background on the Catppuccin Mocha palette, industrial signage type (Archivo caps for structure labels) with technical-drawing discipline (drafting rules, IBM Plex Mono annotations), flat ruled rows and sections instead of nested boxed cards, and high figure-ground contrast**. The rejection was about craft, not darkness.

## Consequences

- **The prototype gives direction only.** The operator accepted the _idea_, requiring: a real modular type scale (prototype sizes are "all over the place"), far fewer hard rules (ruling every boundary makes nothing stand out), bounded line lengths instead of full-viewport rows (hard to scan), and smaller structural labels. Never implement from the prototype file.
- No hazard-stripe "andon" motif or other factory costume; palette, type, and lines define the language.
- Catppuccin Mocha is the token source (base, crust, surface neutrals; peach accent; red, yellow, green, blue run states). State colors are semantic, not decorative.
- No light mode in v1, which is dark-first; colors are tokens, so a Latte variant stays possible.
- The prototype (five switchable skins) is on `prototype/ui-visual-language`.

## Amendment (2026-09-02, #78)

Tokens and components come from the shadcn registry: a preset in `apps/web/components.json` supplies neutrals, radii, and type (Geist for text, Geist Mono for headings and identifiers), with the dark `foreground`, `primary`, and `secondary` tokens set to Catppuccin Mocha text, mauve, and surface0. Archivo and IBM Plex Mono are gone; the palette, dark-first stance, flat ruled sections, and semantic run-state colors stay. `apps/web/README.md` has the working rules.

## Amendment (2026-10-19)

The preset's shadcn-default look was rejected: pill badges, 12px text, and mono headings everywhere made usine look like any app on that kit. Of five board directions, the category standard beat four bolder ones: a kanban at the craft level of Linear, the Vercel dashboard, and Raycast. Operators scanning runs read a clean, familiar convention better than a novel layout. Inter replaces Geist for text, and JetBrains Mono replaces Geist Mono for ids, numbers, times, and code. Catppuccin Mocha stays. Factory references remain only as floor plan: lanes are bays, and an arrow between authored bays lists the loops at work in the left one, which shows where work flows. Elsewhere it would be costume.
