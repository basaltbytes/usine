---
name: usine
description: Operator web UI for usine, a kanban Board of Projects, Runs, and Loops on Catppuccin Mocha.
colors:
  crust: "#11111b"
  mantle: "#181825"
  base: "#1e1e2e"
  surface0: "#313244"
  surface1: "#45475a"
  surface2: "#585b70"
  overlay0: "#6c7086"
  subtext0: "#a6adc8"
  subtext1: "#bac2de"
  text: "#cdd6f4"
  mauve: "#cba6f7"
  blue: "#89b4fa"
  peach: "#fab387"
  red: "#f38ba8"
  green: "#a6e3a1"
  sapphire: "#74c7ec"
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
  repository-mark:
    backgroundColor: "{colors.surface1}"
    textColor: "{colors.text}"
    typography: "{typography.caption}"
    rounded: "{rounded.sm}"
    width: "16px"
    height: "16px"
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

A dense, quiet work tool at the standard of Linear, the Vercel dashboard, and Raycast: a standard kanban (dark sidebar, one inset work panel, lanes of cards), cleaner than stock shadcn, with fewer pills, fewer nested boxes, one type scale, and one action colour.

Factory imagery appears only where it conveys information: thin arrows between authored lanes name the loops that match the left lane's tasks, and empty lanes have a dashed outline. The one logo is the usine mark, in the sidebar, the favicon, and every running state. No other factory imagery, logo, or ornament.

Dark only: the `.dark` block in `src/index.css` is the shipped theme, and `:root` has a Catppuccin Latte fallback that no screen is designed for.

**Key Characteristics:**
- Three grounds: mantle (page, sidebar, cards), base (work panel), surface0 (anything floating).
- 1px white hairlines at 7% instead of filled boxes.
- Mauve is the only action colour; state colours are for run states.
- Inter on a five-size scale, body 13px; JetBrains Mono only for machine text.
- Flat at rest; one shadow for floating elements.

## Colors

Catppuccin Mocha as published: neutral grounds from crust to text, one action accent, and four state colours.

### Primary
- **Mauve** (`{colors.mauve}`): primary buttons, focus rings, links, the text caret, text selection (mixed to 32%), item marks of closed issues and merged pull requests, and the dot of the usine mark, and nothing else.

### Secondary
- **Blue** (`{colors.blue}`): a run that is Pending, Queued, or Running; a flow arrow whose loops are working.
- **Peach** (`{colors.peach}`): a run waiting for approval, and Needs attention (sidebar counts, items, card ring at 45%).
- **Red** (`{colors.red}`): failed runs, error text, destructive actions. Fills are 8 to 25% alpha, never solid.
- **Green** (`{colors.green}`): succeeded runs, a clear project, an active loop, and the live connection dot.
- **Sapphire** (`{colors.sapphire}`): a chart series that is no state, such as tasks done or attempts per run, and its five-step ramp for loops in the order they run; nothing else.

### Neutral
- **Crust** (`{colors.crust}`): text on mauve buttons; the scrim under sheets and dialogs.
- **Mantle** (`{colors.mantle}`): page ground, sidebar, cards, inputs.
- **Base** (`{colors.base}`): the inset work panel and its sticky lane headings.
- **Surface0** (`{colors.surface0}`): popovers, menus, secondary buttons, the active sidebar row.
- **Surface1** (`{colors.surface1}`): secondary button hover, menu item focus, scrollbar thumb, the repository mark's ground.
- **Overlay0** (`{colors.overlay0}`): graphics only (idle flow arrows, canceled and paused state dots, the offline dot); too faint for text.
- **Subtext0** (`{colors.subtext0}`): secondary text, counts, meta, sidebar icons at rest.
- **Subtext1** (`{colors.subtext1}`): sidebar text.
- **Text** (`{colors.text}`): primary text.
- **Hairline** (`{colors.hairline}`): every border and card ring; inputs use a 10% stroke, the sidebar 6%.

GitHub label colours come unchanged from the repository, in the label chip (see Components): data, not palette.

### Named Rules
**The One Action Colour Rule.** Mauve marks what the operator can act on or has focused. States never use mauve; actions use no state colour except destructive red. The exceptions are the item mark, which uses GitHub's state colours (see Item mark), and the usine mark, whose dot is mauve in every state.

**The State Tone Rule.** Blue running, peach waiting and Needs attention, red failed, green succeeded, overlay0 canceled. A state is a 6px dot in its tone, 8px before the state's word, so colour is never the only signal. While a run, attempt, or tool call is running, the 12px running mark (see usine mark) takes the dot's place, centred on it, so rows keep their alignment. A dot that starts a line is indented 3px, so the running mark starts at the line's edge. The same scale marks a project active (blue) or clear (green) and a loop active (live green) or paused (overlay0). An issue or pull request state is an item mark, never a dot.

## Typography

**Body Font:** Inter Variable (optical size axis), with ui-sans-serif, system-ui
**Mono Font:** JetBrains Mono Variable, with ui-monospace

**Character:** One sans family, small and tight like Linear; mono only for machine output.

### Hierarchy
- **Headline** (600, 20px, 28px, -0.01em): screen titles, such as the project name on the board, or Loops.
- **Title** (600, 16px, 24px): section and card titles in the registry Card.
- **Label strong** (600 or 500, 14px, 20px): the sidebar wordmark, sheet titles, alert titles.
- **Body** (400, 13px, 20px): default UI text, buttons, menu items, card titles (500), lane names (600).
- **Caption** (400 or 500, 12px, 16px): meta, run lines, chips, counts, sidebar group names.
- **Mono** (400, 12px, 16px, tabular figures): item numbers, elapsed times, ids, code.

### Named Rules
**The Five Sizes Rule.** Text is 12, 13, 14, 16, or 20px. `@theme` resets `--text-*`, so any other Tailwind size generates nothing.

**The Machine Text Rule.** JetBrains Mono for ids, numbers, times, and code; Inter for headings and labels.

## Layout

A 232px mantle sidebar, then the base work panel, inset 8px from the window's top, right, and bottom, with a 10px radius and a hairline border. Below `md`, the panel fills the screen and the sidebar becomes a sheet. The panel starts with a 48px header with the sidebar toggle, breadcrumb, and a notification bell at the right, then the screen.

Page gutters are 16px, 20px from `md`. The page shell is prose (content stops at 768px) or full (fills the panel: the overview and every configuration page). List screens, such as Loops, are flat on the panel with no card: the page heading, then a table whose text aligns with the heading, so its hairlines and row fills extend 8px past it on each side. Below `sm`, tables drop or fold their least important columns instead of scrolling sideways. The Workers list shows **Location**, and the Repositories list **Tags**, from a 672px table.

**Board.** The project title and counts, then the lanes: 272px wide, 12px apart, scrolling sideways together, with headings sticky on the base ground. Folded lanes are 40px rails with the name set vertically and the count.

**Overview** (`/`). The page heading with counts (`2 running, 7 stalled`), then Statistics, Needs attention, Running, Stalled, and Recent runs, 36px apart, each a 16px semibold title with its count in 13px subtext0, then the Workers line. An empty block is one 13px subtext0 fragment, such as `Nothing running`.

**Tasks list** (`repository › Tasks`). The page heading with counts, a 13px subtext0 totals line, and a flat table; with no runs, `No runs yet` in 13px subtext0. The [README](README.md#tasks-list) lists what each column and status says.

- **Task**: the task's item heading, row form.
- **Status**: a dot in the state's tone (peach for `Needs attention`; for `Done`, the current item's icon-only item mark) and 12px medium words on the row's 20px line, the dot on the first line when the words wrap. ` · ` and the last run's time follow in 12px regular subtext0, the time in mono, on one line with the dot.
- **Runs**: the loops as `start-dev · review-pr · finish-pr`, each after its last run's state dot, then the run count in 12px mono subtext0.
- **Pull request**: the task's other pull requests as item marks, 10px apart.
- **Elapsed time**, **Tokens**, **Estimated cost**: right-aligned 12px mono tabular figures, no words, with a subtext0 `*` hung in the right padding to keep figures aligned. Hovering tokens or cost opens the usage breakdown popover.

Columns follow the table's width, not the window's: **Tokens** and **Estimated cost** from 896px, **Runs** and **Pull request** from 1024px, **Elapsed time** always. The title takes the remaining width on one line, cut short only when the table is narrower than its columns. From a 448px table, **Status** and **Runs** take their own width up to an equal share of what remains after 416px for the title and header width for the figure columns (112px to 208px). Past that, **Status** wraps and **Runs** truncates before the title is cut, and a status word wider than the share, such as the loop `dependency_updates`, breaks. A short status such as `Done · 28m ago` takes only its own width. On a phone, **Status** wraps to its longest word.

**Configuration detail page.** From `lg`, the file's long parts (trigger, selector, prompt, persona, lanes, preflight) are in a main column and its short facts in a 21rem rail on the right behind a hairline; below `lg`, the rail comes first. The heading row has the name, state mark, and file path (12px mono, under the name), with actions at the right that wrap under the path on phones. A worker's preflight table shows **Checked** and **Detail** from a 672px table; in a narrower one, each check's time folds under its result and its message under the check.

**Task page** (`repository › Tasks › Issue #<number>`, the breadcrumb naming the originating item in plain words). At most 1024px wide, flat, with the page gutters, 20px above and 40px below. Header: the page header with the task's item heading; facts are the task's other pull requests as item marks, the lane after `Kanban` (tooltip `Lane`), chips, and Needs attention; Move to is an outline button right of the heading from `sm`. Then Runs, Pull requests, and Comments and reviews, 32px apart, each a 16px semibold title with its count in 13px subtext0, 8px above a flat table. Runs shows every column from `xl`; below, agent, attempts, duration, opened, and pull request fold into one 12px line under the loop, and below `sm` the state's dot joins that line before the loop. Run row cells align to the top, so a failure, approval, or Run again line under the loop doesn't move other cells. An empty section is a hairline, a 13px medium title, and one sentence on how it fills.

**Run page.** Below the breadcrumb (`repository › Run <short id>`), the header is 16px from the panel edges (20px from `md`), with actions right of the title from `lg` and under the facts line otherwise. From `lg`, the outline and reader are side by side:

- **Outline:** a 288px column with a hairline on its right, its own scroll, and 12px side padding. It scrolls to keep the reading-line mark in view with 8px to spare. Below `lg`, it folds into a 36px Outline button naming the part being read, which opens a hairline box at most 60% of the screen tall that closes on a choice.
- **Reader:** at most 616px wide, centred beside the outline, 20px above and 32px below. Each row is a 72px time-and-speaker gutter, a 24px gap, and content at most 504px wide (about 72 characters of 14px prose); below `sm`, time and speaker are one line above the content. It opens on the latest attempt, or below `lg`, at a finished run's outcome.
- **Foot band:** 40px under the reader for Jump to latest or the new-updates count, so no control covers the outcome or salvage line. A live attempt's composer is below it, behind a hairline, on the reader's grid.

Reader spacing: 40px, a hairline, and 32px between attempts; within one, rows 16px apart, fold lines 2px, notes and board move lines 8px, and a GitHub change line 2px under a fold or change line and 8px under prose.

Spacing is a 4px grid, mostly 4, 6, 8, 10, 12, 16, 20, and 24px. Cards stack 8px apart, with 6px between internal rows.

## Elevation & Depth

Depth comes from tonal layering: mantle page, base panel, mantle cards, surface0 popovers. Surfaces are flat at rest, separated by 1px hairlines, with one shadow for floating elements.

### Shadow Vocabulary
- **Raised** (`box-shadow: 0 8px 24px -6px rgb(0 0 0 / 50%), 0 2px 6px -2px rgb(0 0 0 / 35%)`): dropdown menus, popovers, and the card being dragged.

### Named Rules
**The Flat At Rest Rule.** Nothing on the board has a shadow unless it floats. Hovering a card raises its ring from 7% to 15% white, not a shadow.

## Motion

Motion explains a change and is short. One curve and three durations, as tokens in `src/index.css`:

- **`--ease-out-expo`** (`cubic-bezier(0.16, 1, 0.3, 1)`): every arrival and state change.
- **`--duration-fast`** (150ms): small fades, hover colour, and every exit.
- **`--duration-base`** (200ms): panels opening, the sheet sliding in, the overlay fading, the reading mark.
- **`--duration-view`** (250ms): the drawer-to-page view transition.

Content is visible without motion. Under `prefers-reduced-motion: reduce`, durations are zero, view transitions are off, and the running mark is static.

- **Drawer to run page:** Open run page navigates with a view transition. The run header's title (`run-title`) and state (`run-state`) share a `view-transition-name` in the drawer and on the page, so they move into the page while the rest cross-fades. Without view transitions, navigation is immediate.
- **Sheet:** slides in, and its overlay fades in, over 200ms; both leave in 150ms.
- **Panels:** fold lines, delegations, and outline attempts open from 0 to Base UI's `--collapsible-panel-height` while fading in (the `collapsible-motion` utility), and close in 150ms.
- **Reading mark:** each checkpoint rail's 1px mark slides to the reading line's checkpoint over 200ms.
- **Needs attention:** the tray uses the popover transition on desktop and the sheet transition on phones.
- **Controls:** button colour, border, and ring changes take 100ms.
- **Running mark:** a 1.3s linear loop of ten 130ms steps. Each tile is at full opacity for its step, fades over the next two, and stays at 20% for the rest of the cycle, so a bright tile travels the U with a two-tile trail, then three steps pass without one.

## Shapes

Corners step down with nesting: the work panel 10px; cards, lane rails, menus, and Needs attention items 8px; buttons, inputs, and menu items 6px; extra-small buttons 4px. Chips are full pills. Borders are 1px hairlines, drawn as rings on cards so the box size doesn't change. The only dashed line is an empty lane's outline.

## Components

### Buttons
Compact and quiet, mostly 28px tall.
- **Shape:** gently rounded (6px); extra-small buttons 4px.
- **Primary:** mauve fill, crust text, 13px medium, 28px tall, 10px side padding. Hover drops the fill to 88%.
- **Outline:** surface0 at 50% with a 10% white stroke; hover fills surface0.
- **Secondary:** surface0 fill; hover surface1.
- **Ghost:** no fill; hover surface0 at 70%. Icon buttons and Cancel run.
- **Destructive:** red text on red at 15%, 25% on hover.
- **Focus / press:** a 2px mauve ring at 70%; pressing moves the button down 1px; 100ms transitions.

### Chips
- **Label chip:** a 20px pill in the GitHub label's colour: text in the colour (dark ones lifted toward white for contrast), border at 40% alpha, fill at 12%. Used for lane sources, card labels (three, then a muted `+n` chip), and GitHub change lines.
- **Plain chip:** hairline outline, muted text, for item states as lane sources.
- Run state is not a chip but the dot and word from Colors.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** mantle on the base panel.
- **Shadow Strategy:** none at rest; Raised while dragged.
- **Border:** 7% white ring; 15% on hover; peach at 45% when the card needs the operator (65% on hover).
- **Internal Padding:** 10px top and bottom, 12px sides; rows 6px apart.
- **Content order:** each member's item mark, 10px apart; the task's title (two lines, 13px medium); labels; the run line (state mark, loop, state, mono elapsed time, agent at the right). A failure is red text on red at 8% with its action. A stall reason is 12px subtext0, at most three lines, after the loop in text colour if no run line shows it, then the action as an extra-small outline button.
- **Menu:** a 20px ghost icon button in the top right corner, shown on hover or focus with a pointer, always on touch.

### Inputs / Fields
- **Style:** mantle fill, 10% white stroke, 6px radius, 28px tall, 13px text, mauve caret.
- **Focus:** stroke turns mauve at 70%, with a 2px mauve ring at 25%.
- **Error / Disabled:** red stroke with a red ring at 25%; disabled at 50% opacity.

### Navigation
- **Sidebar:** 232px mantle column: the 18px usine mark, centred on the icon column and on the x-height, and the wordmark `usine` in 14px semibold, then groups 20px apart, each a 12px subtext0 name over 32px rows in 13px subtext1. A row starts with a 16px regular-weight Phosphor icon, or a project's repository mark, so the usine mark, icons, repository marks, and group names share one column, and the wordmark and labels another. Under each project, Board and Tasks are 28px rows with their icons under the project name; projects are 6px apart. Icons are subtext0 at rest and text colour on hover and when active: Overview `SquaresFour`, Board `Kanban`, Tasks `ListChecks`, Loops `ArrowsClockwise`, Agents `Robot`, Workers `HardDrives`, Repositories `BookBookmark`, Settings `GearSix`. Hover fills surface0 at 60%; the active row is surface0 across the row's width, with text colour and medium weight. Needs attention counts are peach, 8px from the row's right edge, on hover too. The footer has the live dot, centred in the icon column, and `Live` or `Idle`.
- **Header:** 48px, hairline bottom border, sidebar toggle, breadcrumb, and a notification bell with a peach count at the right.
- **Menus:** surface0 popup, 8px radius, 4px padding, Raised shadow; 28px items in 13px, focus fills surface1; destructive items red with a red 15% focus fill. Menus list only actions that apply.

### Page heading
On the overview, board, tasks list, and configuration pages: the 20px semibold title, after the repository mark on a repository's page, its counts in 13px subtext0 on the same baseline (`9 lanes, 233 items`, `5 loops, 1 paused`), any mark such as Needs attention, and the screen's actions at the right.

### Flat table
The registry table on the panel ground: a 36px heading row of 12px subtext0 labels, 44px rows split by hairlines, 8px cell padding, numbers right-aligned in tabular figures. A row that opens something fills surface0 at 60% on hover and while its link has focus, with a 2px mauve outline on the link; other rows have no hover fill. Row actions are subtext0 ghost buttons, only those that apply, such as Pause or Resume.

One column, usually the item or the detail, takes the remaining width, and its text wraps or is cut short inside it. The other columns take their content's width on one line. A column whose text wraps has a minimum width instead, such as 224px for a preflight check and its description.

### Frontmatter block
Keys and values copied from a file, such as a loop's `on:` and `if:`: a mantle box with a hairline ring and 8px radius, 12px mono, keys in subtext0, values in text colour, wrapping anywhere. Ligatures are off, so `==` reads as written.

### Facts rail
A definition list beside a detail page: 13px subtext0 labels in a 6.5rem column, values in text colour, a value's source or unit in subtext0. Links to other entries are mauve.

### Prompt expression
A `{{ }}` expression in a rendered prompt is outlined, not filled: mono, no fill, a 10% white ring, braces in subtext0. Inline code keeps the surface0 fill, so literals and per-item values look different.

### Slot cells
One 10px cell per worker slot, 4px apart on one line: running blue while an attempt uses it, an empty ring otherwise, with the count beside them.

### Needs attention item
Flat two-line rows separated by hairlines, with 12px horizontal and 6px vertical padding. The first line has the item mark and a truncated 13px medium title, the primary action, and a row menu. The second line has 12px muted context: loop, repository, and recorded age, separated by middle dots. Worker rows show the worker and diagnostic context. Item marks and titles link to GitHub. Secondary actions appear in the row menu; Open run or the primary Details button opens the drawer. Actions stay beside the first line on phones. Seven rows fit in the tray at 1280 × 800. Overview and the notification tray use the same row. Groups have a 12px heading and count, peach in dark mode and foreground in light mode.

The notification tray opens below the bell, aligned to the right: 400px wide on the popover ground, with the Needs attention title and count above a scrolling list and a link to Overview below. On phones it opens as a full-width bottom sheet. Both stop at 70% of the viewport height. The bell's badge is absent when the count is zero.

### Flow arrow
A 22 by 8 one-pixel arrow at the end of an authored lane's heading, crossing the gap to the next authored lane, after the matching loops' names in 12px (`paused` after a paused one). Blue if one has a queued or running run on the lane's tasks, peach if all their open runs wait, otherwise subtext0 with the arrow in overlay0. With no such loop, the arrow is alone, in overlay0.

### Overview rows
Flat tables; only rows about a run open something (its run page). An item cell is the task's item heading, row form; multi-line rows align to the top. A connectivity warning is 12px yellow with a filled warning icon under the item, the harness's message below. Stalled has the reason as a 13px fragment and the action as a subtext0 ghost button. The Workers line ends the live sections under a hairline: `Workers` in 12px medium text colour, then each worker's name in mono, slots in use, and last preflight as a state dot and words, red if failed.

### Statistics
The first overview section: its 16px title, the window's start in 12px subtext0, and the window switch (`7 days`, `30 days`, `All`) as a small outline toggle group at the right. Below, flat on the panel with no cards and no rules, four blocks 36px apart: Tasks done across the width, then Time per task and Tokens per task in a wide column with First time right beside them from `lg`, one column on phones. A block is a 14px medium title, its figures, and its chart; no reading or caption. A figure is a 20px semibold value followed by its unit in 13px subtext0 (`45 tasks`, `2 h 35 min median time in usine`, `~$3.10 median price`). The only sentences are Time per task's loop lines (`finish-pr about 15 min`, the loop in text colour) and one 12px subtext0 line under the blocks naming the tasks left out. Charts follow the dataviz rules: bars at most 24px thick on hairline grids, a 2px base-coloured gap between stacked segments, a legend for two or more series, a tooltip on surface0 with the Raised shadow, and a screen-reader table or label of the values. Durations are medians; no mean or percentile appears.

- **Tasks done:** a dot per task (8px sapphire with a 2px base ring and a 24px hit area) by merge day across and time in usine up a log axis with ticks at `15 min`, `1 h`, `4 h`, `1 d`, `1 w`, and `4 w`, and a 2px subtext0 line at the median; the legend reads `task` and `median`. A window counted per week shows tasks per week as columns over the median per week as a line.
- **Share bars:** Time per task and Tokens per task are one 12px bar split into segments 2px apart, with a legend of swatch, name, and share under it. Loops take the sapphire ramp (`--loop-1` to `--loop-5`) light to dark in the order they run; waiting is surface2. Hovering a segment or legend entry dims the others.
- **Sparklines:** 96 by 28, a 1.5px subtext0 line over at most eight points with the last one a sapphire dot, beside each First time right figure.
- **Details:** a ghost `Details` button with a caret below the blocks, collapsed by default, opens the run statistics: 12px subtext0 labels over 16px semibold values, then 13px medium block titles over the run charts and the runs per loop, agent, or model table.
- **Outcome colour:** succeeded green, failed red, canceled overlay0, the run state tones, in that order in every stack and legend.
- **One-series colour:** sapphire (`--chart-1`, `#74c7ec`) for magnitudes that are no state, such as attempts per run and the slot-use meters (fill on a 15% sapphire track). Needs attention entries use peach.

### Page header
One header for the run page, the run drawer, and the task page: an optional 12px subtext0 line with 14px between facts, each fact after its Phosphor icon at text size in overlay0 with its kind as tooltip; the item heading; a 13px subtext0 facts line with 20px between facts; and the actions, right of the heading from `lg` on the run page and `sm` on the task page, under it in the drawer.

### Run header
The page header of the run page and the drawer. Above the heading: the loop after `ArrowsClockwise` and the agent after `Robot`. The heading is the task's item heading. Facts: the state mark and state line (`Failed after 3 attempts`) in medium text colour; the run's pull request as an item mark unless it names the task; once an attempt has started, the attempts' total in 12px mono after `Timer` (`at least` if an attempt's end wasn't recorded, counting while one runs), on the page only the token total after `Coins` as `159.6K tokens` in mauve with the figure in 12px mono, which opens the usage breakdown, and the worker after `HardDrives`; then `Loop paused`. Each item appears once.

### Run actions
After the run header: right of it from `lg` on the page, under it otherwise. Only the actions that apply, in three places: a primary button for the state's main action, a secondary outline button (ghost for Cancel run), and a 28px subtext0 ghost icon button (`DotsThree`, labelled More actions) whose menu lists the rest, absent when empty. The [README](README.md#run-actions) lists the actions per state. Cancel run turns the buttons into Confirm cancel (destructive) and Keep running (ghost).

### Item mark
The only way an issue or pull request number appears: its Octicon and `#number` in 12px mono, 4px apart, both in the item's state colour, linked to GitHub in a new tab and underlined on hover, with `Pull request #530, closed` as tooltip and accessible name. Inside a row, card, entry, or menu item that opens something else, it doesn't link. Before a title, the icon is 16px and the number 14px, 6px apart; a done task's status uses the icon alone.

| Kind | State | Octicon | Colour |
| --- | --- | --- | --- |
| Issue | Open | `IssueOpened` | green |
| Issue | Closed | `IssueClosed` | mauve |
| Pull request | Open | `GitPullRequest` | green |
| Pull request | Merged | `GitMerge` | mauve |
| Pull request | Closed | `GitPullRequestClosed` | red |
| Either | Unknown | the kind's open icon | subtext0 |

### usine mark
Seven 16-unit tiles with a 4-unit radius form a U around a 6-unit dot on a 64-unit grid (`src/components/usine-mark.tsx`). The tiles are the current text colour at 30, 40, 50, 62, 74, 87, and 100% opacity, in the order work moves through the cell: down the left side, across the bottom, and up the right side. The dot is mauve. Uses:

- **Sidebar:** 18px, text colour (see Navigation).
- **Running mark:** 12px, the tiles in the state's tone, animated (see Motion): the running state of runs, attempts, and tool calls, including the fold line's running count, the reader's current activity, and the overview's Running rows before the loop.
- **Boot screen:** 32px, text colour, animated, while the app or a page loads. Spinners in buttons and toasts stay; they mean loading.
- **Favicon:** the mark on a base square with a 14-unit radius, with the tiles in the surface2 to text ramp (`src/favicon.svg`).

The mark is hidden from screen readers; the word beside it, or a status label, names the state.

### Repository mark
How a repository appears where it names a page or a navigation entry: the sidebar's project rows, the project breadcrumb, the board heading, and in the configuration section the Repositories list, a repository's heading and breadcrumb, and a loop's Repositories fact. The owner's GitHub avatar as a square tile with a 4px radius and a hairline ring, 8px before the name (6px in a breadcrumb): 16px beside 13px text, 20px beside a 20px heading, centred on the first line. GitHub has no per-repository image, so repositories with one owner share the avatar. If it doesn't load, the tile is the name's first letter or digit in 12px semibold text colour on surface1. The mark is hidden from screen readers. Run lines, Needs attention entries, and other mentions in running text show the name alone.

### Item heading
A task's name: its item mark inline in the title's text, a space, then the title, so a wrapped line starts under the icon. The [README](README.md#issues-and-pull-requests) says which item names a task. Page form: the 20px semibold title, the mark's number on its first baseline; the run page heading keeps the `run-title` view transition name. Row form: one 13px medium line that truncates the title and keeps the mark, with the title as tooltip.

### Usage breakdown
A popover from a token total, at most 416px wide, 12px text. `Tokens per pool` lists each billing pool with tokens in mono and a price: dollars in mono text colour, then `estimate` in subtext0 for the Claude and ChatGPT plans; nothing for a pool with no price. On the tasks list, a pool with unpriced usage has `at least` in subtext0 before its price, and the price column widens from 112px to 160px to keep token figures aligned; opened from a cost marked `*`, the popover starts with `Some sessions have no price yet; the real figure is higher.` in subtext0, 8px above `Tokens per pool`. Below a hairline, `Tokens per session` lists each session under its attempt (name, truncated model in mono subtext0, tokens, price) in the same columns. A closing subtext0 line says what a token count is.

### Run outline
13px entries with a 6px radius; hover fills surface0 at 60%, and the part being read fills surface0. Task and Event first, each with a two-line 12px preview, then a 10px space and the attempts. An attempt entry has its state mark at the left, its name, and a caret that turns when open; under them, why it started in 12px subtext0 (`From the Event`, `Retried by octocat`, `Retried after an infrastructure failure`, and `Reattached after a restart` when that happened), then the start time and duration in 12px mono, counting while live. The open attempt lists its sessions as 28px rows (Parent, then each child by agent), with a live session's state at the right in its tone (peach waiting or paused, blue working with elapsed time), then its checkpoints as 26px rows on one hairline rail, in conversation order. A fold of consecutive turns is a caret, the session name in subtext1, and the 12px count (`14 messages`) at the right; open, it lists one-line turn previews 18px in. Other rows (blockers, questions, operator input, worker and provider notices, the outcome) start with the speaker in subtext1; failed or blocked ones are red, warnings yellow. The checkpoint at the reading line, or its closed fold, is text colour and medium, with an 18px, 1px text-colour mark on the rail that slides to it as the reader scrolls. Below a closing hairline: the error count in red with previous and next buttons, then recovered tool failures (`12 recovered`) in subtext0, each only when not zero.

### Fold line
A quiet 12px line for the tool calls between two messages, even a single one: a caret, what the calls did (`Ran 5 commands · baseline gate, pnpm lint`), failed calls counted in red and running ones in blue, then ` · ` and the span in mono. A ghost button at least 28px tall, 8px wider than the reader's text on each side; hover turns the text to text colour. Open, the caret turns, the line has no fill at rest (surface0 at 70% on hover), and the call panels follow, 4px apart.

### GitHub change line
A quiet 12px subtext0 line for an agent's change to the run's GitHub item, under the fold line of the calls that made it. A 14px GitHub mark replaces the caret, 8px before the text. Labels read `Removed`, chips, `, added`, chips, in their GitHub colours. A comment reads `Commented on` and the item's mark, linked to the comment, in the muted colour since its state isn't read; a review reads `Approved`, `Requested changes on`, or `Reviewed` the same way. The text is on a 20px line so chips align to its baseline, at least 28px tall like a fold line. No fill, no hover; the tooltip gives GitHub's recorded time.

### Board move line
The operator's board move during the attempt, placed by time like a GitHub change line but styled as an operator note: the time in the gutter in 12px mono, then one 12px subtext0 line, `You moved it from Review to Findings on the Board`. No GitHub mark (the operator made it) and no chips (the lane names say what moved).

### Attempt heading and meta line
The attempt name in 14px semibold, then one wrapping 12px subtext0 line with 20px between facts: the worker, the parent's harness and model, and each child's agent, harness, model, and effort, values in mono text colour. These facts appear only here.

### Outcome and failure note
The attempt's last row, with time and speaker in the gutter (the speaker red if it failed).
- **Failure note:** 8px radius, red border at 25%, red fill at 8%, 12px sides, 8px top, 10px bottom, 13px text: the typed reason in medium red, then the message as Markdown.
- **Salvage line:** 12px subtext0, 8px under the failure note or the Canceled word: the branch and commit (mono) with the unfinished work, or `No salvage branch.`
- **Succeeded / Canceled:** the state mark and word in 13px medium; a success adds the result message in 14px.

### Run drawer
A right sheet, full width on phones and at most 448px from `sm`. The header (run header without tokens, and actions) is on a hairline with 20px padding. Below it (20px sides, 16px top and bottom, 20px between blocks), one summary: a sentence for a Pending, Waiting, or Queued run; the current activity and latest message (speaker, mono clock time, at most six lines of 14px) for a Running one; the outcome for a finished one. An outline Open run page button ends it; a 24px ghost expand icon before Close, top right, opens the same page, with an `Open Run page` tooltip. No conversation, no tabs.

### Named Rules
**The Said Once Rule.** A run's reader shows each fact once: worker and models in the attempt's meta line, never per message; a final message the outcome repeats, only as the outcome; a parent's copy of a child's message, not at all; a GitHub comment or review the outcome links, or a label change the outcome states in the line's words, only as the outcome.

## Voice

Every string on screen, from title to tooltip, states what is true in common app words.

1. **Glossary words are ordinary nouns.** Run, item, loop, worker, agent, attempt, event, task, board, project, and lane are lowercase inside a sentence. Loop, worker, agent, and repository names keep their own spelling. A page title or navigation label that is one plural noun stays capitalized: Loops, Agents, Workers, Repositories, Settings.
2. **Software is not a person.** A run, loop, item, worker, or agent doesn't wait, ask, want, hold, carry, belong, see, act, or own anything, and is never "its", "their", or "theirs". Write the state: `Waiting for approval`, not `Its Run waits for your approval`.
3. **The fact comes first.** Cut clauses that explain a consequence, such as `so no run opens` or `the loop waits for a retry`. Something for the operator to do is a button, not a sentence.
4. **Common app words, no factory roleplay, no invented terms.** Overview, Running, Stalled, Needs attention, Recent runs, Last checked. Never Desk, Not moving, Needs you, Running now, Last outcomes, or the factory.
5. **Short.** A status or stall reason is a fragment with no final period: `Canceled 2d ago, unchanged since`, `Failed 3h ago: Agent failure`, `Waiting for a free worker slot`, `usine-worker-1 silent since 19:31:03`.

## Do's and Don'ts

### Do:
- **Do** put new screens in the base work panel on the mantle ground, with mantle cards and surface0 popovers.
- **Do** use mauve only for actions, focus, links, selection, and item marks.
- **Do** show state as the State Tone Rule says; animate the usine mark only while something runs or loads, never under reduced motion.
- **Do** keep text on the 12/13/14/16/20 scale, with mono only for ids, numbers, times, and code.
- **Do** keep surfaces flat behind 7% white hairlines, with the Raised shadow only on menus, popovers, and dragged items.
- **Do** render GitHub labels as label chips.
- **Do** set run prose at 14px in the 504px reader column, and fold each burst of tool calls into one fold line.
- **Do** keep the reader's foot band for Jump to latest and new updates, so no control covers the outcome.

### Don't:
- **Don't** add a second accent colour or use a state colour as decoration.
- **Don't** use overlay0 for text; it fails contrast on these grounds.
- **Don't** put run states in pill badges or nest filled boxes.
- **Don't** set headings in mono or use uppercase, letter-spaced labels above headings.
- **Don't** add factory imagery beyond the usine mark, the flow arrows, and dashed empty lanes.
- **Don't** design screens against the light `:root` fallback palette.
- **Don't** break the Said Once Rule.
- **Don't** add tabs or the conversation to the run drawer; the conversation is on the run page.
