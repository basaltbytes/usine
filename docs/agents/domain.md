# Domain docs

## Read before exploring

- `CONTEXT.md` at the repo root: the domain glossary.
- `docs/adr/`: the ADRs for the area you work in.
- `docs/architecture/index.mdx`: the map of what is built and where it is in the tree.

If a file doesn't exist, continue without flagging it or suggesting that someone create it. The `/domain-modeling` skill creates these files when terms or decisions are resolved.

## File structure

Single-context repo:

```
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Use glossary terms

In your output (issue titles, refactor proposals, hypotheses, test names), name domain concepts with the terms in `CONTEXT.md`, not the synonyms it lists under _Avoid_.

If the concept isn't in the glossary, either you're inventing language the project doesn't use (reconsider) or the glossary has a gap (note it for `/domain-modeling`).

## Amend ADRs that a change contradicts

An ADR records why a decision was taken, not a limit on later work. If your change contradicts one, make the change and amend the ADR in the same pull request: add a dated section with the new reason, and name the ADR in the pull request body.
