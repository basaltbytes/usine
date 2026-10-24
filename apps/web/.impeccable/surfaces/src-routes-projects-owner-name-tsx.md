---
version: 1
slug: "src-routes-projects-owner-name-tsx"
primary_target: "src/routes/projects/$owner/$name.tsx"
related_targets: ["src/routes/__root.tsx","src/board/board.tsx"]
---

## Scope

The Board (`/projects/$owner/$name`) and the app shell around it: sidebar, header, Needs you. Operate mode. First surface of the web UI redesign; the theme tokens and registry primitives it changes carry to every other screen, which get their own passes later.

## Audience and job

The single operator, back at the desk after time away, scanning one Project: what moved, what is running, what needs them, what failed. They approve, retry, cancel, open a Run, or move a card between authored lanes.

## Constraints

- Catppuccin Mocha palette and GitHub label colours are kept.
- Craft bar: Linear first, then the Vercel dashboard and Raycast.
- shadcn registry on Base UI stays the component layer; restyle the registry files in place, colours and type only through tokens in `src/index.css`.
- Menus list only the actions that apply.

## Direction contract

THESIS: The category standard, a Linear-grade kanban, executed at full craft on Mocha. It refuses the stock shadcn look (pill badges everywhere, 12px text everywhere, mono headings, soft boxes on boxes) by being cleaner, not by being different.

OWN-WORLD: Mocha mantle sidebar and page ground, base work panel inset with a 1px hairline and 10px corners, mantle cards with a 7% white hairline and 8px corners. Inter for all text on a 12/13/14/16/20 scale, body 13px; JetBrains Mono only for ids, times, and code. Mauve is the one action colour; blue running, peach waiting and Needs you, red failed, green succeeded. GitHub label chips as tinted pills in their own colour. Factory floor plan only as flow arrows between bays and dashed empty bays.

STORY: The operator sees in one glance which bays hold work, where a Loop is running, and what waits on them, then acts from the card or the Needs you row without leaving the Board.

FIRST VIEWPORT: 232px mantle sidebar (wordmark `usine`, Projects with Needs you counts, Configuration). Base panel: 48px header with the breadcrumb only (Reload configuration and its result list stay on the Loops page); Needs you as a two-column row of peach-tinted items with their actions; Project title 20px semibold with lane and item counts; authored lanes first in their configured order, then read-only lanes, with Unmapped and Done collapsed to narrow rails showing name and count until opened; lanes 272px wide with 12px gaps, each headed by name, count, and its label chip, the header sticky while the lane scrolls. Between authored lanes, a thin flow arrow in the header row names the Loops with open Runs on the left bay's Tasks. Cards: number and kind in mono, title on two lines, other labels, Run line with state mark, Loop, state, time, and Agent.

FORM: The category standard (canon), chosen over the roll; not on the grounded list. seed:b25d54104af2e439

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Approved sketch

`apps/web/.impeccable/mocks/decision/canon.html`, plus the flow arrows and dashed empty bays from the follow-up round.

## Unresolved

- Flow arrows name Loops from open Runs only. Naming the Loops whose triggers watch a lane needs the server to evaluate triggers per lane; that is a follow-up.
- Projects home and the Run drawer get their own surface passes after the Board.
