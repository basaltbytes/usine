---
name: usine
description: Operator web UI for usine, a kanban Board of Projects, Runs, and Loops on Catppuccin Mocha.
colors:
  crust: "#11111b"
  mantle: "#181825"
  base: "#1e1e2e"
  surface0: "#313244"
  surface1: "#45475a"
  overlay0: "#6c7086"
  subtext0: "#a6adc8"
  subtext1: "#bac2de"
  text: "#cdd6f4"
  mauve: "#cba6f7"
  blue: "#89b4fa"
  peach: "#fab387"
  red: "#f38ba8"
  green: "#a6e3a1"
  hairline: "rgb(255 255 255 / 7%)"
  input-stroke: "rgb(255 255 255 / 10%)"
  sidebar-hairline: "rgb(255 255 255 / 6%)"
  scrim: "rgb(17 17 27 / 72%)"
typography:
  headline:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: "1.75rem"
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.5rem"
  label-strong:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: "1.25rem"
  body:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  caption:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
  mono:
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
    fontFeature: "\"tnum\""
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.mauve}"
    textColor: "{colors.crust}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  button-outline:
    backgroundColor: "{colors.surface0}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  button-destructive:
    textColor: "{colors.red}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  input:
    backgroundColor: "{colors.mantle}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
    height: "28px"
  task-card:
    backgroundColor: "{colors.mantle}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "10px 12px"
  label-chip:
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "0 8px"
    height: "20px"
  menu:
    backgroundColor: "{colors.surface0}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "4px"
  menu-item:
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
    height: "28px"
  work-panel:
    backgroundColor: "{colors.base}"
    rounded: "{rounded.xl}"
  sidebar:
    backgroundColor: "{colors.mantle}"
    textColor: "{colors.subtext1}"
    width: "232px"
  run-outline:
    typography: "{typography.body}"
    padding: "0 12px 16px"
    width: "288px"
  run-outline-item:
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 8px 6px 24px"
  fold-line:
    textColor: "{colors.subtext0}"
    typography: "{typography.caption}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
    height: "28px"
  github-change-line:
    textColor: "{colors.subtext0}"
    typography: "{typography.caption}"
    padding: "4px 0"
    height: "28px"
  failure-note:
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "8px 12px 10px"
  run-drawer:
    backgroundColor: "{colors.base}"
    width: "448px"
---

# Design System: usine

## Overview

**Creative North Star: "A Linear-grade kanban on Catppuccin Mocha, with a floor plan between the bays"**

The operator UI is a dense, quiet work tool held to the craft of Linear, the Vercel dashboard, and Raycast. It reads as a standard kanban: a dark sidebar, one inset work panel, lanes of cards. It improves on the stock shadcn look by being cleaner, with fewer pills, fewer boxes on boxes, one type scale, and one action colour.

The factory idea appears only where it carries information. Thin arrows between authored lanes name the Loops that watch the left lane's Tasks, and an empty lane shows a dashed outline. The rest of the screen has no factory imagery, no logo, and no ornament.

The world is dark only. The `.dark` block in `src/index.css` is what ships; `:root` holds a Catppuccin Latte fallback that no screen is designed against.

**Key Characteristics:**
- Three grounds: mantle for the page, sidebar, and cards; base for the work panel; surface0 for anything that floats.
- 1px white hairlines at 7% instead of filled boxes.
- Mauve is the only action colour; state colours belong to Run state.
- Inter on a five-size scale, body at 13px; JetBrains Mono only for machine text.
- Flat at rest; one shadow for things that float.

## Colors

The palette is Catppuccin Mocha used as stated: neutral grounds from crust to text, one action accent, and four state colours.

### Primary
- **Mauve** (`{colors.mauve}`): primary buttons, focus rings, links, the text caret, and text selection (mixed to 32%). Nothing else uses it.

### Secondary
- **Blue** (`{colors.blue}`): a Run that is Pending, Queued, or Running; a flow arrow whose Loops are at work.
- **Peach** (`{colors.peach}`): a Run waiting for approval and everything marked Needs attention (sidebar counts, Needs attention items, card ring at 45%).
- **Red** (`{colors.red}`): failed Runs, error text, destructive actions. Fills use it at 8 to 25% alpha, never solid.
- **Green** (`{colors.green}`): succeeded Runs, a clear Project, an active Loop, and the live connection dot.

### Neutral
- **Crust** (`{colors.crust}`): text on mauve buttons; the scrim colour under sheets and dialogs.
- **Mantle** (`{colors.mantle}`): page ground, sidebar, cards, inputs.
- **Base** (`{colors.base}`): the inset work panel and the sticky lane headings that sit on it.
- **Surface0** (`{colors.surface0}`): popovers, menus, secondary buttons, the active sidebar row.
- **Surface1** (`{colors.surface1}`): hover on secondary buttons, menu item focus, scrollbar thumb.
- **Overlay0** (`{colors.overlay0}`): graphics only: idle flow arrows, the canceled and paused state dots, the offline dot. Too faint for text.
- **Subtext0** (`{colors.subtext0}`): secondary text, counts, meta.
- **Subtext1** (`{colors.subtext1}`): sidebar text.
- **Text** (`{colors.text}`): primary text.
- **Hairline** (`{colors.hairline}`): every border and card ring. Inputs use a 10% stroke, the sidebar 6%.

GitHub label colours are kept as they come from the repository and rendered by the label chip (see Components); they are data, not palette.

### Named Rules
**The One Action Colour Rule.** Mauve marks what the operator can act on or has focused. State never borrows mauve, and actions never borrow a state colour except destructive red.

**The State Tone Rule.** Blue running, peach waiting and Needs attention, red failed, green succeeded, overlay0 canceled. A state is shown as a 6px dot in its tone next to the state's word, so colour is never the only signal. Projects, Loops, and Items borrow the scale: a Project is active in blue or clear in green; a Loop is active in the live green or paused in overlay0; an Item is merged in green, closed in overlay0, and open in subtext0.

## Typography

**Body Font:** Inter Variable (optical size axis), with ui-sans-serif, system-ui
**Mono Font:** JetBrains Mono Variable, with ui-monospace

**Character:** One sans family for all text, set small and tight like Linear; mono appears only where the text is machine output.

### Hierarchy
- **Headline** (600, 20px, 28px, -0.01em): the screen title, such as the Project name on the Board or Loops.
- **Title** (600, 16px, 24px): section and card titles in the registry Card.
- **Label strong** (600 or 500, 14px, 20px): the sidebar wordmark, sheet titles, alert titles.
- **Body** (400, 13px, 20px): default UI text, buttons, menu items, card titles (500), lane names (600).
- **Caption** (400 or 500, 12px, 16px): meta, Run lines, chips, counts, sidebar group names.
- **Mono** (400, 12px, 16px, tabular figures): Item numbers and kinds, elapsed times, ids, code.

### Named Rules
**The Five Sizes Rule.** Text is 12, 13, 14, 16, or 20px. `@theme` resets `--text-*`, so any other Tailwind size generates nothing.

**The Machine Text Rule.** JetBrains Mono is for ids, numbers, times, and code. Headings and labels are Inter.

## Layout

A 232px mantle sidebar on the left; to its right the base work panel, inset 8px from the window on top, right, and bottom, with a 10px radius and a hairline border (below the `md` breakpoint the panel fills the screen and the sidebar becomes a sheet). The panel opens with a 48px header holding the breadcrumb only, then the Needs attention row, then the screen. On Overview, Needs attention is the screen's first block instead.

On the Board, Needs attention items sit in a two-column grid from `lg` (one column below) with 10px gaps. The Project title and its counts follow, then the lanes: 272px wide, 12px apart, scrolling sideways together. Each lane heading is sticky on the base ground while its cards scroll. Folded lanes become 40px rails showing the name vertically and the count. Page gutters are 16px, 20px from `md`.

The Overview page at `/` fills the panel: the page heading with its counts (`2 running, 7 stalled`), then Needs attention, Running, Stalled, and Recent runs, 36px apart, each a 16px semibold title with its count in 13px subtext0 beside it and a flat table under it, then the Workers line. An empty block is one 13px subtext0 fragment under its title, such as `Nothing running`.

The Tasks list (`repository › Tasks`) fills the panel: the page heading with its counts (`2 in flight, 1 needs attention, 2 done`, a zero count left out), then a flat table of the Tasks usine ran. Task is the originating Item's number in 12px mono subtext0 and the title in 13px medium, on one line. Status is a dot in the state's tone and the words in 12px medium on the row's 20px line, the dot staying on the first line when the words wrap: `Running` and the Loop, `Waiting for approval`, the stall fragment, `Needs attention` with a peach dot, `Done` with a green dot when merged or an overlay0 one when closed, or the last Run's outcome. Runs lists the Loops in the order they first ran, `start-dev · review-pr · finish-pr`, each after its last Run's state dot, then the Run count in 12px mono subtext0. Last run is the Loop, state, and time in 12px mono; Pull request is the number in 12px mono mauve with `open` or `merged` in 12px subtext0. Time, Tokens, and Cost are right-aligned 12px mono tabular numbers, `estimate` after a Claude plan cost in 12px subtext0, and `at least` before a cost in 12px subtext0 while part of the usage has no price yet; hovering Tokens or Cost opens a surface0 popover with the tokens per billing pool, the Run page's Tokens per pool. Under the heading, one 13px subtext0 line adds up the listed Tasks: `9 runs, 6 h 12 min, 4.8M tokens, $14.20 estimate`. Tokens and Cost need a table 896px wide and Runs and Pull request 1024px; Time always shows. The title takes the width the other columns leave and stays on one line, cut short only when the table is narrower than its columns. From a 448px table, Status, Runs, and Last run take their own width up to an equal share of what the table has left once the title has 416px and the figure columns theirs, between 112px and 208px; past it Status and Last run wrap and Runs truncates, so they give way before the title does. On a phone Status and Last run wrap to their longest word. With no Run on any Task, `No runs yet` is one 13px subtext0 line.

List screens sit flat on the panel, with no card around them: the page heading, then a table. The page shell has two widths: prose stops content at 768px, full fills the panel (Overview and every Configuration page). A table's text lines up with the heading, so its hairlines and row fills reach 8px past the heading on each side. Below `sm`, a table drops or folds its least important columns instead of scrolling sideways.

A Configuration detail page puts the file's long parts (trigger, selector, prompt, persona, lanes, preflight) in a main column and its short facts in a 21rem rail on the right, behind a hairline, from `lg`; below `lg` the rail comes first. The heading row carries the entry's name, its state mark, and its file path in 12px mono under the name, with the actions at the right; on phones the actions wrap under the path.

The Task page (`repository › Tasks › #<number>`) is a document at most 1024px wide, flat on the panel with 16px gutters (20px from `md`), 20px above and 40px below. Its header comes first: the originating Item's number in 12px mono mauve, linking to GitHub, on the baseline of the 20px title, then a facts line in 13px with 20px between facts (the current Item's state in medium text colour, `Lane` and its name, the label chips, Needs attention), and Move to as an outline button at the right of the title from `sm`. Three sections follow 32px apart, each a 16px semibold title with its count in 13px subtext0 on the same baseline, 8px above a flat table: Runs, Pull requests, and Comments and reviews. Runs shows all its columns from `xl` and folds Agent, Attempts, duration, opened, and pull request into one 12px line under the Loop below it; below `sm` the state column folds into that line too, its dot before the Loop. A run row's cells align to the top so a failure, approval, or Run again line sits under the Loop without moving the other cells. An empty section is a hairline with a 13px medium title and one sentence on how it fills.

List screens (Loops) sit flat on the panel, with no card around them: the page heading, then a table at most 768px wide. Its text lines up with the heading, so its hairlines and row fills reach 8px past the heading on each side. Below `sm`, a table drops or folds its least important columns instead of scrolling sideways.

The Run page fills the panel below the breadcrumb (`repository › Run <short id>`) and any Needs attention row. Its header comes first, 16px from the panel edges (20px from `md`), with the Run's actions at the right of the title from `lg` and below the facts line under it. Below the header, the outline and the reader sit side by side from `lg`:

- **Outline:** a 288px column with a hairline on its right and its own scroll, 12px side padding. It follows the reader: the Attempt being read is the open one, the checkpoint at the reading line is marked, and the outline scrolls itself to keep that mark in view with 8px to spare. Choosing a checkpoint scrolls the reader to it. Below `lg` the outline folds into a 36px Outline button that names the part being read; it opens as a hairline box at most 60% of the screen tall and closes once something is chosen.
- **Reader:** a column at most 616px wide, centred in the space beside the outline, with 20px above and 32px below. Each row is a 72px time-and-speaker gutter, a 24px gap, and content at most 504px wide, which holds about 72 characters of 14px prose. Below `sm` the gutter becomes one line of time and speaker above the content. The reader opens on the latest Attempt; below `lg`, a finished Run opens at its outcome.
- **Foot band:** a 40px band under the reader holds Jump to latest or the new-updates count, so the control never covers the outcome or the salvage line. A live Attempt's message composer sits below it behind a hairline, on the reader's grid.

Attempts in the reader are separated by 40px, a hairline, and 32px; rows within one are 16px apart, fold lines 2px, notes and Board move lines 8px, and a GitHub change line 2px under a fold line or another change line and 8px under prose.

Spacing is a 4px grid used mainly at 4, 6, 8, 10, 12, 16, 20, and 24px. Cards stack 8px apart with 6px between their internal rows.

## Elevation & Depth

Depth comes from tonal layering: mantle page, base panel, mantle cards, surface0 popovers. Surfaces are flat at rest and separated by 1px hairlines. One shadow exists, for elements that float above the page.

### Shadow Vocabulary
- **Raised** (`box-shadow: 0 8px 24px -6px rgb(0 0 0 / 50%), 0 2px 6px -2px rgb(0 0 0 / 35%)`): dropdown menus, popovers, and the card being dragged.

### Named Rules
**The Flat At Rest Rule.** Nothing on the Board casts a shadow unless it floats. Hover on a card raises its ring from 7% to 15% white, not a shadow.

## Motion

Motion explains a change and stays short. One curve and three durations, defined as tokens in `src/index.css`:

- **`--ease-out-expo`** (`cubic-bezier(0.16, 1, 0.3, 1)`): every arrival and state change decelerates hard and settles.
- **`--duration-fast`** (150ms): small fades, hover colour, and every exit.
- **`--duration-base`** (200ms): panels opening, the sheet sliding in, the overlay fading, the reading mark.
- **`--duration-view`** (250ms): the drawer-to-page view transition, the one authored moment.

Content is visible without motion. Under `prefers-reduced-motion: reduce` all three durations are zero and view transitions are off.

- **Drawer to Run page:** Open Run page navigates with a view transition. The Run header's title (`run-title`) and state (`run-state`) carry the same `view-transition-name` in the open drawer and on the page, so they glide from the drawer into the page while the rest of the screen cross-fades. Browsers without view transitions navigate at once.
- **Sheet:** slides in and its overlay fades in over 200ms; both leave in 150ms.
- **Panels:** fold lines, delegations, and an outline Attempt opening to its sessions grow from 0 to Base UI's `--collapsible-panel-height` while fading in (the `collapsible-motion` utility); closing runs at 150ms.
- **Reading mark:** one 1px mark per checkpoint rail slides to the checkpoint at the reading line over 200ms.
- **Needs attention:** a new entry fades in over 150ms.
- **Controls:** button colour, border, and ring changes run 100ms.

## Shapes

Corners step with nesting: the work panel 10px, cards, lane rails, menus, and Needs attention items 8px, buttons, inputs, and menu items 6px, extra-small buttons 4px. Chips are full pills. Borders are 1px hairlines, drawn as rings on cards so they do not change the box. The only dashed line is the outline of an empty lane.

## Components

### Buttons
Compact and quiet; most actions are 28px tall.
- **Shape:** gently rounded (6px); extra-small buttons 4px.
- **Primary:** mauve fill, crust text, 13px medium, 28px tall, 10px side padding. Hover drops the fill to 88%.
- **Outline:** surface0 at 50% with a 10% white stroke; hover fills surface0.
- **Secondary:** surface0 fill; hover surface1.
- **Ghost:** no fill; hover surface0 at 70%. Used for icon buttons and Cancel Run.
- **Destructive:** red text on red at 15%, 25% on hover.
- **Focus / press:** a 2px mauve ring at 70%; pressing moves the button down 1px. Transitions run 100ms.

### Chips
- **Label chip:** a 20px pill in the GitHub label's own colour: text in the colour (dark colours lifted toward white for contrast), border at 40% alpha, fill at 12%. Used for lane sources and card labels, three per card, then a muted `+n` chip, and in GitHub change lines.
- **Plain chip:** hairline outline with muted text, for Item states as lane sources.
- Run state is not a chip; it is the dot and word described in Colors.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** mantle on the base panel.
- **Shadow Strategy:** none at rest; Raised while dragged.
- **Border:** 7% white ring; 15% on hover; peach at 45% when the card needs the operator (65% on hover).
- **Internal Padding:** 10px top and bottom, 12px sides; rows 6px apart.
- **Content order:** Item numbers and kinds in mono; title, two lines, 13px medium; labels; Run line (state dot, Loop, state, mono elapsed time, Agent at the right). A failure shows as red text on red at 8% with Retry, or with Mark answered or Mark resolved for a question or blocker. A stalled Task shows its stall reason, the same fragment as on Overview, in 12px subtext0, at most three lines, after the Loop in text colour when no Run line shows the Loop, then the one action as an extra-small outline button.
- **Menu:** a 20px ghost icon button in the top right corner, shown on hover or focus on pointer devices and always on touch.

### Inputs / Fields
- **Style:** mantle fill, 10% white stroke, 6px radius, 28px tall, 13px text, mauve caret.
- **Focus:** stroke turns mauve at 70% with a 2px mauve ring at 25%.
- **Error / Disabled:** red stroke with a red ring at 25%; disabled at 50% opacity.

### Navigation
- **Sidebar:** 232px mantle column. The wordmark `usine` in 14px semibold, then group names in 12px subtext0, then 32px rows in 13px subtext1. Each Project has Board and Tasks under it as 28px rows on a hairline rail. Hover fills surface0 at 60%; the active row is surface0 with text colour and medium weight. Needs attention counts sit at the row's right in peach. The footer shows the live dot and word.
- **Header:** 48px, hairline bottom border, sidebar toggle and breadcrumb only.
- **Menus:** surface0 popup, 8px radius, 4px padding, Raised shadow; 28px items in 13px, focus fills surface1; destructive items in red with a red 15% focus fill. Menus list only actions that apply.

### Page heading
The screen title in 20px semibold, its counts beside it in 13px subtext0 on the same baseline (`9 lanes, 233 items`, `5 loops, 1 paused`), then any mark such as Needs attention, with the screen's actions at the right of the row. Shared by Overview, the Board, the Tasks list, and the Configuration pages.

### Flat table
The registry table on the panel ground: a 36px heading row of 12px subtext0 labels, then 44px rows split by hairlines, 8px cell padding, numbers right-aligned in tabular figures. A row that opens something fills surface0 at 60% on hover and while its link has focus, and the link takes a 2px mauve outline; rows that open nothing have no hover fill. Row actions are ghost buttons in subtext0 that show only what applies, such as Pause or Resume.

### Frontmatter block
Keys and values copied from a file, such as a Loop's `on:` and `if:`: a mantle box with a hairline ring and 8px radius, 12px mono, keys in subtext0, values in text colour and wrapping anywhere. Ligatures are off, so `==` reads as written.

### Facts rail
A definition list of short facts beside a detail page: 13px labels in subtext0 in a 6.5rem column, values in text colour; a value's source or unit follows in subtext0. Links to other entries are mauve.

### Prompt expression
A `{{ }}` expression in a rendered prompt is outlined, not filled: mono on no fill with a 10% white ring, its braces in subtext0. Inline code keeps the surface0 fill, so a literal and a value filled in per Item read apart.

### Slot cells
One 10px cell per Worker slot, 4px apart: filled in the running blue while an Attempt holds it, an empty ring otherwise, with the count beside them.

### Needs attention item
Peach-tinted row: 8px radius, peach border at 25%, peach fill at 5% (8% on hover), 14px by 10px padding. Title 13px medium, context in 12px, and its actions (primary and ghost buttons) at the right. The whole row opens the related Run.

**Compact:** on the Run page, where the reader below needs the height, Needs attention lists one entry per row in a single column, 6px apart, with 12px by 4px padding and no repository. The title stays whole. From `sm` the entry is one line with its detail shortened beside the title, 12px apart, the full detail in its tooltip; below `sm` the detail wraps to two lines under the title.

### Flow arrow
A 22 by 8 one-pixel arrow at the end of an authored lane's heading, crossing the gap to the next authored lane. The Loops whose trigger matches one of the lane's Tasks sit before it in 12px, with `paused` after a paused one: blue if one of them has a queued or running Run on the lane's Tasks, peach if their open Runs all wait, otherwise subtext0 with the arrow in overlay0. Without such a Loop, the arrow stands alone in overlay0.

### Overview rows
The Overview tables follow the flat table. A row about a Run opens its Run page; a row that names no Run opens nothing. A cell holds the Item as its number in 12px mono subtext0 and its title in 13px medium, truncated; rows that hold more than one line align to the top. A connectivity warning sits under the Item in 12px yellow with a filled warning icon, the harness's message under it. Stalled gives the reason as one 13px fragment and the one action that applies as a ghost button in subtext0. The Workers line closes the page under a hairline: `Workers` in 12px medium text colour, then each Worker's name in mono, its slots in use, and its last preflight as a state dot and words, red when it failed.

### Run header
Shared by the Run page and the drawer. The Item number in 12px mono mauve, linking to GitHub, on the title's baseline 10px before it; the title in 20px semibold on the page and 16px in the drawer. Under it, the facts line in 13px subtext0 with 20px between facts: the state mark and the state line (`Failed after 3 Attempts`) in medium text colour, the pull request link or `No pull request`, `Loop` and `Agent` with their values in text colour. Once an Attempt has started, a second line in the same style says where and how long the Run worked: `Worker` and its name, `Duration` and the Attempts' total in 12px mono (`at least` when an Attempt's end was never recorded), counting while one runs; on the page only, `Tokens` and the total in 12px mono mauve, which opens the usage breakdown. The actions that apply follow, as buttons.

### Usage breakdown
A popover from the Run header's token total, 416px wide at most, 12px text. `Tokens per pool` lists each billing pool with its tokens in mono and its price: dollars in mono text colour, followed by `estimate` in subtext0 for the Claude plan, and `No dollar rate` in subtext0 for the ChatGPT plan, which is never priced. On the Tasks list, a pool with usage not priced yet shows `at least` in subtext0 before its price, and the price column of every pool line widens from 112px to 160px so the token figures stay aligned. Below a hairline, `Tokens per session` lists each session under its Attempt: the session's name, its model in mono subtext0 truncated, tokens, and price, on the same three columns. A closing line in subtext0 says what a token count is.

### Run outline
13px entries with a 6px radius; hover fills surface0 at 60% and the part being read fills surface0. Task and Event come first, each with a two-line 12px preview, then a 10px space and the Attempts. An Attempt entry carries its state mark at the left, its name, and a caret that turns when it opens; under them why it began in 12px subtext0 (`From the Event`, `Retried by octocat`, `Retried after an infrastructure failure`, and `Reattached after a restart` when that happened), then its start time and duration in 12px mono, the duration counting while the Attempt is live. The open Attempt lists its sessions as 28px rows (Parent, then each child by Agent), a live session's state at the right in its tone (peach waiting or paused, blue working with its elapsed time), then its checkpoints as 26px rows on one hairline rail in conversation order. Consecutive turns of one session fold into one row: a caret, the session's name in subtext1, and the count (`14 messages`) in 12px at the right; opening it lists each turn's one-line preview 18px in. Blockers, questions, operator input, Worker and provider notices, and the outcome are rows of their own, named by who said them in subtext1 before the preview; a failed or blocked one is red and a warning yellow. The checkpoint at the reading line, or its closed fold, turns text colour and medium, with an 18px, 1px text-colour mark on the rail that slides to it as the reader scrolls. A hairline closes the outline above the counts: errors in red with previous and next buttons, and under them, quieter in subtext0, the tool failures the Agent recovered from (`12 recovered`), each shown only when it is not zero.

### Fold line
One quiet 12px line in place of a burst of tool calls between two messages: a caret, what the calls did (`Ran 5 commands · baseline gate, pnpm lint`), failed calls counted in red and running ones in blue, then ` · ` and the span in mono. It is a ghost button, 28px tall at least, bleeding 8px past the reader's text on each side; hover turns its text to text colour. Open, the caret turns and the line keeps no fill at rest (surface0 at 70% on hover), with each call's panel below it, 4px apart. A single tool call folds the same way.

### GitHub change line
One quiet 12px subtext0 line for a change an Agent made on the Run's GitHub Item, placed where it happened: under the fold line of the calls that made it, before the next message. A 14px GitHub mark sits where a fold line has its caret, 8px before the text. Labels read `Removed`, their chips, `, added`, their chips, each chip in its GitHub colour as on the Board; a comment reads `Commented on` and the Item number in mono mauve linking to the comment, and a review `Approved`, `Requested changes on`, or `Reviewed` the same way. The text runs on a 20px line so chips sit on its baseline, 28px tall at least like a fold line. It has no fill and no hover; its tooltip gives the time GitHub recorded the change.

### Board move line
The operator's Board move made while the Attempt worked the Item, placed by its time like a GitHub change line but set as an operator note: the time in the gutter in 12px mono, then one 12px subtext0 line, `You moved it from Review to Findings on the Board`. It has no GitHub mark, since the operator made it, and no chips, since the lane names say what moved.

### Attempt heading and meta line
Each Attempt opens with its name in 14px semibold, then one 12px subtext0 line, wrapping, with 20px between facts: the Worker, the parent's harness and model, each child's Agent, harness, model, and effort, with values in mono text colour. These facts appear here once and on no message.

### Outcome and failure note
An Attempt ends with its outcome in the reader's content column, the gutter showing its time and speaker (the speaker in red when it failed).
- **Failure note:** 8px radius, red border at 25%, red fill at 8%, 12px sides, 8px top and 10px bottom, 13px text. The typed reason in medium red, then the message as Markdown.
- **Salvage line:** 12px subtext0, 8px under the failure note or the Canceled word: where unfinished work was pushed, branch and commit in mono, or `No salvage branch.`
- **Succeeded / Canceled:** the state mark and the word in 13px medium; a success follows with the result message in 14px.

### Run drawer
A short summary of one Run over any screen. A right sheet, full width on phones and at most 448px from `sm`. The header (Run header, facts, the Worker and Duration line without tokens, actions) sits on a hairline with 20px padding; below it, 20px sides and 16px top and bottom, 20px between blocks, one summary: a sentence for a Pending, Waiting, or Queued Run; for a Running Run the current activity and the latest message (speaker, mono clock time, at most six lines of 14px); for a finished Run its outcome as above. An outline Open Run page button ends it, and an expand icon button (24px ghost, the same as Close) sits just before Close in the top-right corner with the same destination and an `Open Run page` tooltip. The drawer has no conversation and no tabs.

### Named Rules
**The Said Once Rule.** A Run's reader shows each fact once: Worker and models in the Attempt's meta line, never per message; a final message that the outcome repeats only as the outcome; a parent's copy of a child's message not at all; a GitHub comment or review the outcome links, or a label change the outcome states in the line's words, only as the outcome.

## Voice

Every string on screen, from a title to a tooltip, says what is true in common app words.

1. **Glossary words are ordinary nouns.** Run, item, loop, worker, agent, attempt, event, task, board, project, and lane are lowercase inside a sentence. A loop, worker, agent, or repository name keeps its own spelling. A page title or navigation label that is one plural noun stays capitalized: Loops, Agents, Workers, Repositories, Settings.
2. **Software is not a person.** A run, loop, item, worker, or agent does not wait, ask, want, hold, carry, belong, see, act, or own anything, and is never "its", "their", or "theirs". Write the state: `Waiting for approval`, not `Its Run waits for your approval`.
3. **The fact comes first.** Cut the clause that explains a consequence, such as `so no run opens` or `the loop waits for a retry`. When the operator has something to do, that is a button, not a sentence.
4. **Common app words, no factory roleplay, no invented terms.** Overview, Running, Stalled, Needs attention, Recent runs, Last checked. Never Desk, Not moving, Needs you, Running now, Last outcomes, or the factory.
5. **Short.** A status or stall reason is a fragment with no final period: `Canceled 2d ago, unchanged since`, `Failed 3h ago: Agent failure`, `Queued, no free worker`, `usine-worker-1 silent since 19:31:03`.

## Do's and Don'ts

### Do:
- **Do** put new screens in the base work panel on the mantle ground, with mantle cards and surface0 popovers.
- **Do** use mauve only for actions, focus, links, and selection.
- **Do** show state as a 6px dot in the state's tone beside the state's word; pulse the dot only while Running, and not under reduced motion.
- **Do** keep text on the 12/13/14/16/20 scale and use mono only for ids, numbers, times, and code.
- **Do** separate surfaces with 7% white hairlines and keep them flat; use the Raised shadow only for menus, popovers, and dragged items.
- **Do** render GitHub labels as tinted pills in their own colour.
- **Do** set a Run's prose at 14px in the 504px reader column beside the 72px time-and-speaker gutter, and fold each burst of tool calls between messages to one fold line.
- **Do** keep the reader's foot band clear for Jump to latest and new updates, so no control floats over the outcome.

### Don't:
- **Don't** add a second accent colour or use a state colour for decoration.
- **Don't** use overlay0 for text; it fails contrast on these grounds.
- **Don't** wrap Run states in pill badges or nest a filled box inside another filled box.
- **Don't** set headings in mono or use uppercase, letter-spaced labels above headings.
- **Don't** add factory imagery that carries no information; the floor plan is limited to flow arrows and dashed empty lanes.
- **Don't** design screens against the light `:root` palette; it is a fallback.
- **Don't** repeat a Run's outcome, its Worker and models, or a child's final message elsewhere in the reader; see the Said Once Rule.
- **Don't** put the Run drawer's summary in tabs or show the conversation in it; the conversation is on the Run page.
