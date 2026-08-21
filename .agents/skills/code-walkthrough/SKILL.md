---
name: code-walkthrough
description: Generate an interactive, GitHub-styled single-file HTML walkthrough of a pull request or code change — UML-ish model diagram, fields & methods, views, wizards, security, a translations widget (.po counts, not diffs), test TLDRs, and a Files-changed list. Use when the user asks to visualize, explain, or document a PR/diff/change, asks for a "code walkthrough" or "PR walkthrough", says "visualize this change", or wants a shareable HTML explainer. Odoo-focused but works for any codebase.
---

# Code walkthrough

Produces one self-contained HTML file that reads like a GitHub PR page: a sidebar
with colored filenames, a PR header that links to the real PR, an interactive
model-relationship diagram, per-model field/method cards, views, wizards, security,
and a Files-changed list. **The look is fixed by bundled components; you only author
the content.**

## How it works

```
assets/   octicons-sprite.html · walkthrough.css · walkthrough.js   ← the constant chrome (don't fork per-PR)
scripts/  build.mjs · i18n.mjs                                      ← deterministic renderer + chrome strings
examples/ pr-96 (backend: models/SQL view) · pr-93 (frontend: OWL/MVC view)  ← anonymized worked examples to copy
```

The examples are **inputs only** (`*.content.mjs`) — no built HTML ships, because it's a
deterministic build artifact that would go stale. Preview one any time:
`node scripts/build.mjs examples/pr-96.content.mjs /tmp/preview.html`.

Output language: pass `lang: "fr"` (or any table in `scripts/i18n.mjs`) in the content
model to render the GitHub chrome in that language; authored prose is whatever you write.
The bundled examples are anonymized synthetic data — safe to publish, fine to copy.

You write a **content module** (data only). `build.mjs` inlines the assets and renders
it. Every walkthrough comes out structurally identical — that is the point. Never
hand-write CSS, the sprite, or the JS into a walkthrough; if the look must change, edit
the file in `assets/` so **all** walkthroughs change together.

## Quick start

```bash
cd .claude/skills/code-walkthrough
cp examples/pr-96.content.mjs /tmp/pr-NNN.content.mjs   # backend PR; use pr-93 for frontend/OWL
# ...edit /tmp/pr-NNN.content.mjs for the target PR...
node scripts/build.mjs /tmp/pr-NNN.content.mjs docs/walkthroughs/pr-NNN.html
open docs/walkthroughs/pr-NNN.html
```

## Workflow

1. **Gather the change.** `gh pr view <n> --json title,number,url,author,baseRefName,headRefName,additions,deletions,changedFiles,body,files` (the `files` array carries per-file `additions`/`deletions` → the `+N −M` counts) and `gh pr diff <n>`. Read the new and changed files. Note the canonical **PR url** — the header links to it.
2. **Extract the anatomy** (see REFERENCE.md → "What to extract"): new models (and `_auto=False` SQL views), modified models with their new fields (`compute`, `@api.depends`, relations) and methods, new/changed views and their *intent*, wizards (transient models — say "none" explicitly if there are none and why), security (`ir.model.access.csv` rows + `ir.rule` records), and the **why** in plain language. For frontend-heavy PRs (OWL components, JS views, services, QWeb templates, Hoot tests) use REFERENCE.md → "Frontend / OWL PRs": same section skeleton, components instead of models — lean on the `odoo-frontend` and `owl` skills to read the code accurately.
   **Views, translations, and tests each get their own section** (own sidebar entry):
   - *Translations* (`i18n/*.po`, `*.pot`): never paste `.po` diffs or list msgids. Count entries per file and emit one `i18n` block — one row per language plus the template (REFERENCE.md → "Translations").
   - *Tests*: read them fully, then emit a `tests` block — a TLDR per test: 1–2 sentence scenario plus the key assertions, paraphrased. No full test diffs (REFERENCE.md → "Tests").
3. **Author the content module.** Copy `examples/pr-96.content.mjs`. Fill `pr`, `files[]`, and `sections[]` from the block catalog (REFERENCE.md). Put code in `String.raw` template literals — the builder HTML-escapes it.
4. **Build & verify.** Run `build.mjs`, open the HTML, click a diagram node, confirm sidebar filename colors (green = added, amber = modified) and the GitHub link.

## Writing the "Why this PR exists" section

Lead with it and keep it concrete, concised: a named persona, a before/after, the actual screen.
Plain language, no jargon dump. Two-to-four sentences of setup, then the one
architectural idea a reviewer should check the diff against, then what it deliberately
doesn't do. Write deliverables in English. See REFERENCE.md for the full content schema
and block catalog.


# Absolute rules of writing quality 

- Be concise, direct and neutral
- Always write as if the public never read the code and they were not participating in the coding
session that lead to the PR.
- If writing in english, ALWAYS report in ASD-STE100 Simplified Technical English
- Use the /anti-slop-writing and /public-facing-copy skills with sub-agents to self-review your writing
and the clarity of your walkthrough. Tweak until you have good quality writing

## If writing in french

- keep english technical word that are naturally used in technical sphere as english, do not
do word for word translation
- use the style of "Rédaction technique simplifiée" mirroring the logic of STE (one term per concept, short active-voice sentences, avoiding metaphors)