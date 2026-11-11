# Loops select items with CEL over GitHub's payload

A loop's trigger names a stream (`issue`, `pr`, or `schedule`), and a CEL `if:` over that stream's payload slice, which keeps GitHub's shapes, selects the items. The same evaluator renders the prompt's `{{ }}` expressions and evaluates a conditional `approval` and a computed `priority`. An approval condition that fails to evaluate requires approval. The CEL library is pinned exactly behind `ExpressionEngine` in `@usine/expression`.

Loops are edited in forms first, with a text editor in the export format as the fallback. Expression fields complete against the payload and are checked on the server. A preview lists the stored items a draft matches and renders its prompt, without calling GitHub. A new loop starts paused (ADR 0031), and resuming it first shows its match count. An agent's model is free text, with suggestions.

The export format is Markdown with YAML frontmatter, so the prompt, the most edited part, is the body.

## Considered options

- **Filter keys per trigger** (`label: ready`): an invented vocabulary in which each new filter is an engine change.
- **A visual condition builder**: the same catalog as a UI, with two representations of one expression.
- **A TypeScript DSL**: the orchestrator would run operator code, and forms couldn't rewrite it.
- **Pure YAML**: the prompt becomes an indentation-sensitive block scalar.
- **A curated model list**: a stale list would block new model IDs.
