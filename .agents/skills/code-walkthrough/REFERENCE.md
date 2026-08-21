# code-walkthrough — content schema & block catalog

The builder (`scripts/build.mjs`) turns a **content model** into HTML. Author it as a
`.mjs` module with a `default` export (code blocks use `String.raw` so you don't escape
anything) or as plain `.json`. The builder HTML-escapes all code; everything else in
text/`html` fields is passed through as raw HTML, so you may use `<code>`, `<b>`, `<i>`,
`<span class="tag">`, etc.

## What to extract (Odoo)

| Ask | Where to look | Renders as |
| --- | --- | --- |
| New models | `models/*.py` `_name`, `_inherit`, `_auto` (SQL view!), `_description` | a `model` section (new badge) |
| Fields | `fields.X(...)`, `compute=`, `@api.depends`, relations, `readonly`, `groups` | `fields` block |
| Methods | `def`, decorators (`@api.depends/constrains/model`), intent | `methods` block |
| Views & intent | `views/*.xml` records, inherited XPath, smart buttons | `views` section (`cards` + `table` + `code`) |
| Wizards | `wizards/` `TransientModel`; if none, say so and why | `wizards` section |
| Security | `security/ir.model.access.csv` (CRUD matrix), `ir.rule` records | `matrix` + `code` |
| Translations | `i18n/*.po`, `*.pot` — count entries per language, **never paste diffs** | `i18n` block, own section |
| Tests | `tests/*.py`, tours — read fully, then summarize scenario + assertions | `tests` block, own section |
| Why | PR body, linked issue, ADR/PRD, CONTEXT.md | `narrative` section |

**Keep views, translations, and tests in separate sections**, each with its own nav
entry — do not fold them into model sections. Reviewers must be able to skip the
translation flood in one glance and still find it in the sidebar.

### Translations (`i18n` block) — counts, not diffs

`.po`/`.pot` diffs flood a review and carry near-zero review signal. Never render them
as `code` blocks and never list every changed msgid. Instead: count entries per file
(`git diff --numstat` for line counts; count `msgid` additions/changes/removals for
entry counts, e.g. `gh pr diff <n> -- 'i18n/*.po'` piped through grep) and emit **one
`i18n` block** with one row per file. Reserve prose for the only reviewable facts: a
new language added, entries deleted, or the `.pot` template drifting from the source.

### Tests (`tests` block) — TLDR, not the diff

Test diffs are long; the reviewer wants what each test **proves**. Read the test code
fully, then write one `tests` item per test (or per test class when tests are tiny):
one-to-two-sentence `scenario` (given/when/then in plain language), then `asserts` —
the two-to-four key assertions, paraphrased, not pasted. Attach at most one short
`code` excerpt (collapsed) when a setup trick is itself review-worthy. Tag tours with
`kind: "tour"`, HTTP cases with `kind: "http"`.

### Frontend / OWL PRs

When a PR is mostly web-client JavaScript (OWL components, views, services, registries,
QWeb templates, Hoot tests), keep the *same section skeleton* but reinterpret it — the
structure generalizes from "models" to "components/services":

| Backend concept | Frontend equivalent | How to render it |
| --- | --- | --- |
| Model | OWL component / service / view class / patch | a section per JS file (nav `file: true`) |
| Fields | component **props** (`static props`, JSDoc types), reactive **state** (`useState`) | `fields` block — name, type from JSDoc, note |
| Methods | lifecycle hooks (`onWillStart`/`onMounted`), event handlers, getters | `methods` block — `sig` is the method, `decorator` can hold the hook |
| Views (arch) | QWeb template (`static/src/**/*.xml`), `js_class`, registry entry | `code` block `lang: "markup"`; a `table` for registry rows |
| Security | n/a (note assets/manifest instead) | `table` of `assets` bundle entries |
| Tests | Hoot tests (`static/tests/**`) | `tests` block — same TLDR discipline: scenario + key `expect(...)`s, no diff |
| Diagram | component tree / service graph | nodes = components/services; edges = `renders`, `uses`, `patches`, `registered in` |

Code langs: use `lang: "javascript"` for `.js`/`.esm.js`, `lang: "markup"` for QWeb XML,
`lang: "scss"`/`"css"` for styles. The builder loads all of these. For OWL specifics
(props/state/hooks, `registry.category(...)`, `patch(...)`, `useService`), prefer the
project's `odoo-frontend` / `owl` skills to read the code correctly, then transcribe into
the blocks here.

## Top-level shape

```js
export default {
  lang: "en",            // chrome language: "en" | "fr" | … (default "en"); see Languages
  strings: { … },        // optional: override individual chrome strings (rarely needed)
  pr: { number, title, state, url, author, baseRef, headRef, commits, module,
        summaryHtml, stats: { filesChanged, additions, deletions, extra: [".."] },
        highlights: [ { icon: "🗄️", title, html } ] },   // optional grid of 3
  files: [ { status: "A"|"M"|"D", path: "addons/.../x.py", href?: "#m-x", add?: 78, del?: 0 } ],
  sections: [ /* ordered; see below */ ],
  footerHtml: "..."   // optional
}
```

> Authored prose (summaries, section bodies) is written directly in whatever language
> you want — `lang`/`strings` only translate the **fixed GitHub chrome** (state pill,
> "files changed", "View on GitHub", the code-block toggle, the diffstat header).

- `pr.state` → `open | merged | draft | closed` (colors the pill). `pr.url` makes the
  `#NN` and a "View on GitHub" link clickable — always set it.
- `files[].href` (optional) makes a row jump to a section. `add`/`del` (optional, per
  file — get them from `gh pr view <n> --json files`) render GitHub's `+N −M` counts and
  the mini green/red bar, so readers don't need the GitHub diff view.

## Sections

Each section: `{ id, nav, heading, blocks }`.

- `nav: { label, icon, group }` — sidebar entry. `group` is a header ("Orientation",
  "Models", "Surface", "Quality", "Deep dive"); reuse the same string to group entries.
  Put the Tests and Translations sections under their own group (the examples use
  "Quality") so a reviewer can skip or find them at a glance.
- For **file** entries (model files), use `nav: { label: "x.py", group, file: true, status: "A"|"M"|"D" }`
  — the label renders monospace and colored (green added / amber modified / red deleted)
  with the matching file octicon.
- `heading: { icon, title, change?: "new"|"mod", badge?: { cls: "new"|"mod"|"ctx", label, octicon? } }`
  — `change` tints the heading octicon; `title` may contain HTML.
- `files?: [{ status, path }]` — renders a **file-chip bar** under the heading (status
  icon coloured + monospace path) so every section shows which file(s) it covers, not
  just the model sections. Add it to Views, Security, Wizards, etc.
- The section with `id: "overview"` is special: its header/hero/highlights come from
  `pr`. Give it a `nav` and (usually) empty `blocks`.

## Block catalog (`blocks: [...]`)

| `c` | Fields | Notes |
| --- | --- | --- |
| `intro` | `html` | muted lead paragraph (`.sec-intro`) |
| `p` | `html` | paragraph |
| `h3` | `text` | sub-heading |
| `html` | `html` | raw passthrough (escape hatch) |
| `callout` | `tone?: "key"\|"warn"`, `html` | colored aside |
| `attrs` | `items: [str]` | row of monospace `.tag` chips (model `_name`, `_auto`, …) |
| `flow` | `steps: [html]` | left-to-right strip with `→` arrows |
| `fields` | `headers?: [a,b,c]` (default `Field`/`Type`/`Meaning`; pass `["Name","Kind","Note"]` for JS props/state — the table is generic name/kind/note, not Odoo-field-specific), or just `noteHead?`; `rows: [{ name, type, note(html), badges?: [{cls,label}] }]` | name/kind/note table |
| `methods` | `items: [{ decorator?, sig, html }]` | method cards |
| `code` | `path?`, `lang: "python"\|"markup"\|"javascript"\|"scss"\|"css"`, `code`, `collapsed?: false` | collapsible code (collapsed by default) |
| `table` | `head: [str]`, `rows: [[cellHtml]]`, `firstColMono?` | generic table |
| `matrix` | `head: [str]`, `rows: [[cellHtml]]` | security CRUD grid; use `<span class="yes">✓</span>` / `<span class="no">—</span>` |
| `cards` | `cols?: 2\|3`, `items: [{ title?, html }]` | bordered card grid |
| `patterns` | `title?`, `items: [{ icon, term, html, ref? }]` | **GitHub-native list** of transferable techniques (octicon + term + one-liner + code ref). Preferred over `concepts`. |
| `concepts` | `items: [{ icon (emoji), title, html }]` | emoji-card grid. Legacy/marketing look — avoid; use `patterns`. |
| `files` | — | renders the GitHub Files-changed list (with `+N −M` + bar) from top-level `files` |
| `removed` | `title?`, `items: [{ path, del?, why? }]` | red list box for **deleted** files — surface removals first-class on refactor PRs (`why` is plain text, no markup) |
| `i18n` | `title?`, `intro?`, `note?` (footer html), `rows: [{ path, status?: "A"\|"M", lang?: "fr", add?, del?, entries?: { new?, updated?, removed? }, note? }]` | translation widget: one row per `.po`/`.pot` file — lang tag (omit `lang` for the `.pot` → "template" tag), entry-count chips, `+N −M` bar. **The** way to show translation churn; never paste `.po` diffs |
| `tests` | `title?`, `intro?`, `items: [{ name, kind?: "unit"\|"tour"\|"http", ref?: "tests/test_x.py", scenario (html), asserts?: [html], code?: { path?, lang?, code } }]` | test TLDR cards: mono test name + kind badge, 1–2 sentence scenario, ✓-list of key assertions, optional collapsed excerpt. Summarize — don't paste the diff |
| `diagram` | see below | interactive model/component map |

## Diagram block

```js
{ c: "diagram", intro?, hint?,
  nodes: [ {
    id: "n-pool", model: "planning.pool.item",
    change: "new"|"mod"|"ctx",
    badge?: { cls: "new"|"mod", label },     // or nlabel: "Opportunity"
    target?: "#m-pool",                       // click → scroll to section
    col: 3, row: 2,                           // CSS grid placement (1-based)
    compartments: [ { label: "SQL view", rows: [ '<span class="k">allocation_id</span> · total' ] } ]
  } ],
  edges: [ { from: "n-slot", to: "n-alloc", kind: "new"|"derived"|"ctx", label, thick?: true } ]
}
```

`kind` → `new` solid green, `derived` dashed blue (SQL-view), `ctx` faint dashed grey.
Edges are drawn by `walkthrough.js` from `window.WALKTHROUGH.edges` (the builder emits
this). The legend is fixed. Put the **engine relation** (the link the whole PR turns on)
as a `thick` `new` edge.

## Octicons available (sprite ids `oct-<name>`)

`beaker` `book` `check-circle-fill` `chevron-down` `chevron-right` `code-square` `columns`
`database` `diff-added` `diff-modified` `diff-removed` `dot-fill` `eye` `file-added`
`file-diff` `file` `gear` `git-branch` `git-compare` `git-pull-request` `globe` `info` `law`
`light-bulb` `link-external` `list-unordered` `package` `repo` `rows` `shield-lock` `table`

Use one with `<svg class="octicon"><use href="#oct-NAME"/></svg>` inside any `html`
field, or pass the bare `NAME` to `nav.icon` / `heading.icon` / `badge.octicon`.
Add more by fetching `https://unpkg.com/@primer/octicons@19.11.0/build/svg/<name>-16.svg`
and pasting a `<symbol id="oct-<name>" viewBox="0 0 16 16">…</symbol>` into
`assets/octicons-sprite.html`.

## Languages

The fixed chrome strings live in `scripts/i18n.mjs` (`en` and `fr` ship). Select one with
`lang: "fr"` in the content model; override single strings with `strings: { viewOnGitHub: "…" }`.
Numbers format to the table's locale, and `<html lang>` is set. To **add a language**, copy
the `en` table in `i18n.mjs`, translate the values, and keep the shape — composite entries
(`wantsToMerge`, `filesHeader`) are functions so word order can differ. The two runtime
strings (the code-block toggle) are emitted to `window.WALKTHROUGH.strings` for the JS.

## Changing the look (applies to every walkthrough)

- Colors, spacing, components → `assets/walkthrough.css` (Primer dark palette at the
  top; the "GitHub UI kit" block near the bottom holds the reusable component classes).
- Interactivity (diagram, collapse, scrollspy) → `assets/walkthrough.js`.
- Icons → `assets/octicons-sprite.html`.
- Chrome strings / languages → `scripts/i18n.mjs`.
- Page assembly / Prism pinning + SRI → `scripts/build.mjs`.

Rebuild after any change. Because the chrome is shared, one edit keeps all walkthroughs
consistent — that is how output stays constant.
