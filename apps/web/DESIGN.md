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

The factory idea appears only where it carries information. Thin arrows between authored lanes name the Loops at work on the left lane's Tasks, and an empty lane shows a dashed outline. The rest of the screen has no factory imagery, no logo, and no ornament.

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
- **Peach** (`{colors.peach}`): a Run waiting for approval and everything marked Needs you (sidebar counts, Needs you items, card ring at 45%).
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

**The State Tone Rule.** Blue running, peach waiting and Needs you, red failed, green succeeded, overlay0 canceled. A state is shown as a 6px dot in its tone next to the state's word, so colour is never the only signal. Projects and Loops borrow the scale: a Project is active in blue or clear in green; a Loop is active in the live green or paused in overlay0.

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

A 232px mantle sidebar on the left; to its right the base work panel, inset 8px from the window on top, right, and bottom, with a 10px radius and a hairline border (below the `md` breakpoint the panel fills the screen and the sidebar becomes a sheet). The panel opens with a 48px header holding the breadcrumb only, then the Needs you row, then the screen.

On the Board, Needs you items sit in a two-column grid from `lg` (one column below) with 10px gaps. The Project title and its counts follow, then the lanes: 272px wide, 12px apart, scrolling sideways together. Each lane heading is sticky on the base ground while its cards scroll. Folded lanes become 40px rails showing the name vertically and the count. Page gutters are 16px, 20px from `md`.

List screens (Projects, Loops) sit flat on the panel, with no card around them: the page heading, then a table at most 768px wide. Its text lines up with the heading, so its hairlines and row fills reach 8px past the heading on each side. Below `sm`, a table drops or folds its least important columns instead of scrolling sideways.

The Run page fills the panel below the breadcrumb (`Projects › repository › Run <short id>`) and any Needs you row. Its header comes first, 16px from the panel edges (20px from `md`), with the Run's actions at the right of the title from `lg` and below the facts line under it. Below the header, the outline and the reader sit side by side from `lg`:

- **Outline:** a 288px column with a hairline on its right and its own scroll, 12px side padding. It follows the reader: the Attempt being read is the open one, the checkpoint at the reading line is marked, and the outline scrolls itself to keep that mark in view with 8px to spare. Choosing a checkpoint scrolls the reader to it. Below `lg` the outline folds into a 36px Outline button that names the part being read; it opens as a hairline box at most 60% of the screen tall and closes once something is chosen.
- **Reader:** a column at most 616px wide, centred in the space beside the outline, with 20px above and 32px below. Each row is a 72px time-and-speaker gutter, a 24px gap, and content at most 504px wide, which holds about 72 characters of 14px prose. Below `sm` the gutter becomes one line of time and speaker above the content. The reader opens on the latest Attempt; below `lg`, a finished Run opens at its outcome.
- **Foot band:** a 40px band under the reader holds Jump to latest or the new-updates count, so the control never covers the outcome or the salvage line. A live Attempt's message composer sits below it behind a hairline, on the reader's grid.

Attempts in the reader are separated by 40px, a hairline, and 32px; rows within one are 16px apart, fold lines 2px, notes 8px, and a GitHub change line 2px under a fold line or another change line and 8px under prose.

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
- **Needs you:** a new entry fades in over 150ms.
- **Controls:** button colour, border, and ring changes run 100ms.

## Shapes

Corners step with nesting: the work panel 10px, cards, lane rails, menus, and Needs you items 8px, buttons, inputs, and menu items 6px, extra-small buttons 4px. Chips are full pills. Borders are 1px hairlines, drawn as rings on cards so they do not change the box. The only dashed line is the outline of an empty lane.

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
- **Content order:** Item numbers and kinds in mono; title, two lines, 13px medium; labels; Run line (state dot, Loop, state, mono elapsed time, Agent at the right). A failure shows as red text on red at 8% with Retry.
- **Menu:** a 20px ghost icon button in the top right corner, shown on hover or focus on pointer devices and always on touch.

### Inputs / Fields
- **Style:** mantle fill, 10% white stroke, 6px radius, 28px tall, 13px text, mauve caret.
- **Focus:** stroke turns mauve at 70% with a 2px mauve ring at 25%.
- **Error / Disabled:** red stroke with a red ring at 25%; disabled at 50% opacity.

### Navigation
- **Sidebar:** 232px mantle column. The wordmark `usine` in 14px semibold, then group names in 12px subtext0, then 32px rows in 13px subtext1. Hover fills surface0 at 60%; the active row is surface0 with text colour and medium weight. Needs you counts sit at the row's right in peach. The footer shows the live dot and word.
- **Header:** 48px, hairline bottom border, sidebar toggle and breadcrumb only.
- **Menus:** surface0 popup, 8px radius, 4px padding, Raised shadow; 28px items in 13px, focus fills surface1; destructive items in red with a red 15% focus fill. Menus list only actions that apply.

### Page heading
The screen title in 20px semibold, its counts beside it in 13px subtext0 on the same baseline (`9 lanes, 233 items`, `5 loops, 1 paused`), then any mark such as Needs you, with the screen's actions at the right of the row. Shared by the Board, Projects, and Loops.

### Flat table
The registry table on the panel ground: a 36px heading row of 12px subtext0 labels, then 44px rows split by hairlines, 8px cell padding, numbers right-aligned in tabular figures. A row that opens something fills surface0 at 60% on hover and while its link has focus, and the link takes a 2px mauve outline; rows that open nothing have no hover fill. Row actions are ghost buttons in subtext0 that show only what applies, such as Pause or Resume.

### Needs you item
Peach-tinted row: 8px radius, peach border at 25%, peach fill at 5% (8% on hover), 14px by 10px padding. Title 13px medium, context in 12px, and its actions (primary and ghost buttons) at the right. The whole row opens the related Run.

**Compact:** on the Run page, where the reader below needs the height, Needs you lists one entry per row in a single column, 6px apart, with 12px by 4px padding and no repository. The title stays whole. From `sm` the entry is one line with its detail shortened beside the title, 12px apart, the full detail in its tooltip; below `sm` the detail wraps to two lines under the title.

### Flow arrow
A 22 by 8 one-pixel arrow at the end of an authored lane's heading, crossing the gap to the next authored lane. When Loops have open Runs on the lane's Tasks, their names sit before it in 12px, blue if any Run is queued or running, peach if all are waiting; otherwise the arrow alone in overlay0.

### Run header
Shared by the Run page and the drawer. The Item number in 12px mono mauve, linking to GitHub, on the title's baseline 10px before it; the title in 20px semibold on the page and 16px in the drawer. Under it, the facts line in 13px subtext0 with 20px between facts: the state mark and the state line (`Failed after 3 Attempts`) in medium text colour, the pull request link or `No pull request`, `Loop` and `Agent` with their values in text colour. The actions that apply follow, as buttons.

### Run outline
13px entries with a 6px radius; hover fills surface0 at 60% and the part being read fills surface0. Task and Event come first, each with a two-line 12px preview, then a 10px space and the Attempts. An Attempt entry carries its state mark at the left, its name, and a caret that turns when it opens; under them its start time and duration in 12px mono, the duration counting while the Attempt is live. The open Attempt lists its sessions as 28px rows (Parent, then each child by Agent), a live session's state at the right in its tone (peach waiting or paused, blue working with its elapsed time), and each session's checkpoints as 26px rows on a hairline rail: one-line previews in subtext0, a failed or blocked one in red. The checkpoint at the reading line turns text colour and medium, with an 18px, 1px text-colour mark on the rail that slides from checkpoint to checkpoint as the reader scrolls. When the Run has errors, a hairline and a red count with previous and next buttons close the outline.

### Fold line
One quiet 12px line in place of a burst of tool calls between two messages: a caret, what the calls did (`Ran 5 commands · baseline gate, pnpm lint`), failed calls counted in red and running ones in blue, then ` · ` and the span in mono. It is a ghost button, 28px tall at least, bleeding 8px past the reader's text on each side; hover turns its text to text colour. Open, the caret turns and the line keeps no fill at rest (surface0 at 70% on hover), with each call's panel below it, 4px apart. A single tool call folds the same way.

### GitHub change line
One quiet 12px subtext0 line for a change an Agent made on the Run's GitHub Item, placed where it happened: under the fold line of the calls that made it, before the next message. A 14px GitHub mark sits where a fold line has its caret, 8px before the text. Labels read `Removed`, their chips, `, added`, their chips, each chip in its GitHub colour as on the Board; a comment reads `Commented on` and the Item number in mono mauve linking to the comment, and a review `Approved`, `Requested changes on`, or `Reviewed` the same way. The text runs on a 20px line so chips sit on its baseline, 28px tall at least like a fold line. It has no fill and no hover; its tooltip gives the time GitHub recorded the change.

### Attempt heading and meta line
Each Attempt opens with its name in 14px semibold, then one 12px subtext0 line, wrapping, with 20px between facts: the Worker, the parent's harness and model, each child's Agent, harness, model, and effort, with values in mono text colour. These facts appear here once and on no message.

### Outcome and failure note
An Attempt ends with its outcome in the reader's content column, the gutter showing its time and speaker (the speaker in red when it failed).
- **Failure note:** 8px radius, red border at 25%, red fill at 8%, 12px sides, 8px top and 10px bottom, 13px text. The typed reason in medium red, then the message as Markdown.
- **Salvage line:** 12px subtext0, 8px under the failure note or the Canceled word: where unfinished work was pushed, branch and commit in mono, or `No salvage branch.`
- **Succeeded / Canceled:** the state mark and the word in 13px medium; a success follows with the result message in 14px.

### Run drawer
A short summary of one Run over any screen. A right sheet, full width on phones and at most 448px from `sm`. The header (Run header, facts, actions) sits on a hairline with 20px padding; below it, 20px sides and 16px top and bottom, 20px between blocks, one summary: a sentence for a Pending, Waiting, or Queued Run; for a Running Run the current activity and the latest message (speaker, mono clock time, at most six lines of 14px); for a finished Run its outcome as above. An outline Open Run page button ends it, and an expand icon button (24px ghost, the same as Close) sits just before Close in the top-right corner with the same destination and an `Open Run page` tooltip. The drawer has no conversation and no tabs.

### Named Rules
**The Said Once Rule.** A Run's reader shows each fact once: Worker and models in the Attempt's meta line, never per message; a final message that the outcome repeats only as the outcome; a parent's copy of a child's message not at all; a GitHub comment or review the outcome links, or a label change the outcome states in the line's words, only as the outcome.

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
