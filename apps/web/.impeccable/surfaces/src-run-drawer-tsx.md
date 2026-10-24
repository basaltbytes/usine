---
version: 1
slug: "src-run-drawer-tsx"
primary_target: "src/run-drawer.tsx"
related_targets: ["src/run-transcript/transcript.tsx","src/run-transcript/conversation.tsx"]
---

## Scope

The Run view: a short Run drawer over any screen (`?run=`) and a full-width Run page for reading the whole Run. Operate mode. Inherits the shipped design system in `apps/web/DESIGN.md`.

## Audience and jobs

The single operator, often, all four: see what a live Run is doing now; check the outcome of a finished Run; intervene (approve, retry, edit and retry, message the parent or a child, pause, release a held child, cancel, mark resolved, mark answered); understand a failure.

## What the operator rejected in the old drawer

Tool-call noise burying the story; the same text repeated (child's final message, the parent's copy, "Attempt finished"; states and counts in header, filters and status lines); model, effort, Worker, session ids and durations on every message; Task, Event and Attempts hidden behind tabs.

## Constraints

- Every behaviour the web README describes for the drawer keeps working, re-homed on the page or the drawer: interventions and their rules, held children, Load earlier, Jump to latest, following the tail, unread counts, error navigation, reading-place bookmarks (ADR 0025), resume commands for Claude and Codex children, rate-window meters, salvage branch or retained worktree, Raw details.
- Menus and action rows list only the actions that apply.

## Direction contract

THESIS: A document reader for a Run. An outline of the Run's parts on the left, the selected part read at a 72-character measure on the right. It refuses the chat-log-plus-tabs drawer that shows every tool call and every fact at once.

OWN-WORLD: DESIGN.md unchanged: mantle sidebar, base panel, Inter on 12/13/14/16/20, JetBrains Mono for ids, commands, times; mauve the one action colour; state as a 6px mark plus a word; red-tinted failure note; outline selection as a surface0 nav fill.

STORY: The operator opens a Run, sees at once whether it failed, succeeded, waits, or runs, acts from the header, and reads the agent's own words in order, opening a folded tool burst only when they need the mechanics.

FIRST VIEWPORT: Breadcrumb Projects › repository › Run <short id>. Header: the Item number and title as the 20px heading, then state ("Failed after 3 Attempts"), the PR link or "No pull request", Loop, Agent; the actions that apply on the right. Left, a ~288px outline: Task and Event with a two-line preview each; Attempts with outcome mark, start time and duration, the selected one expanded to its sessions (parent, each child) and message checkpoints, a blocked or failed checkpoint in red. Right, the reader: one quiet line naming the Attempt's Worker and models once; then time and speaker in a narrow left column, messages as continuous text at 14px in a ~72ch column, each burst of tool calls between two messages folded to one line ("Ran 5 commands · baseline gate, pnpm lint · 25s", failed calls counted in red), ending in the failure note and the salvage line. The parent's copy of a child's final message and "Attempt finished" are not shown again.

FORM: Outline and reader, dealt structure 3 of 7 on the grounded list, chosen by the operator. seed:f1eb3a9a51dd7871

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## The drawer

Short: the same header (state, Item, actions), the outcome or failure in one paragraph, for a live Run the current activity and the latest message, and "Open Run" to the page. No conversation, no tabs.

## Approved sketch

`apps/web/.impeccable/mocks/decision/run-outline.html` (first viewport only; the build owes responsive behaviour, live and waiting states, below-the-fold content, and every state the sketch skips).
