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

Spacing is a 4px grid used mainly at 4, 6, 8, 10, 12, 16, 20, and 24px. Cards stack 8px apart with 6px between their internal rows.

## Elevation & Depth

Depth comes from tonal layering: mantle page, base panel, mantle cards, surface0 popovers. Surfaces are flat at rest and separated by 1px hairlines. One shadow exists, for elements that float above the page.

### Shadow Vocabulary
- **Raised** (`box-shadow: 0 8px 24px -6px rgb(0 0 0 / 50%), 0 2px 6px -2px rgb(0 0 0 / 35%)`): dropdown menus, popovers, and the card being dragged.

### Named Rules
**The Flat At Rest Rule.** Nothing on the Board casts a shadow unless it floats. Hover on a card raises its ring from 7% to 15% white, not a shadow.

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
- **Label chip:** a 20px pill in the GitHub label's own colour: text in the colour (dark colours lifted toward white for contrast), border at 40% alpha, fill at 12%. Used for lane sources and card labels, three per card, then a muted `+n` chip.
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

### Flow arrow
A 22 by 8 one-pixel arrow at the end of an authored lane's heading, crossing the gap to the next authored lane. When Loops have open Runs on the lane's Tasks, their names sit before it in 12px, blue if any Run is queued or running, peach if all are waiting; otherwise the arrow alone in overlay0.

## Do's and Don'ts

### Do:
- **Do** put new screens in the base work panel on the mantle ground, with mantle cards and surface0 popovers.
- **Do** use mauve only for actions, focus, links, and selection.
- **Do** show state as a 6px dot in the state's tone beside the state's word; pulse the dot only while Running, and not under reduced motion.
- **Do** keep text on the 12/13/14/16/20 scale and use mono only for ids, numbers, times, and code.
- **Do** separate surfaces with 7% white hairlines and keep them flat; use the Raised shadow only for menus, popovers, and dragged items.
- **Do** render GitHub labels as tinted pills in their own colour.

### Don't:
- **Don't** add a second accent colour or use a state colour for decoration.
- **Don't** use overlay0 for text; it fails contrast on these grounds.
- **Don't** wrap Run states in pill badges or nest a filled box inside another filled box.
- **Don't** set headings in mono or use uppercase, letter-spaced labels above headings.
- **Don't** add factory imagery that carries no information; the floor plan is limited to flow arrows and dashed empty lanes.
- **Don't** design screens against the light `:root` palette; it is a fallback.
