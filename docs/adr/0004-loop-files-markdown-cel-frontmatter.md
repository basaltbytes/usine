# Loop files are Markdown with CEL-filtered frontmatter

A loop file is `loops/<name>.md` in the instance repo: YAML frontmatter for the structured half (trigger, selector, approval, step, agent slot), the Markdown body as the prompt template. The trigger names a watched stream (`on:`) and all item selection is a CEL expression (`if:`) over a per-stream GraphQL slice of GitHub's own object graph — there is no per-trigger-type filter-key catalog. The same CEL namespace powers optional `{{ }}` interpolation in the body, over an always-prepended context preamble carrying repo and payload.

## Considered Options

- **TypeScript DSL** (Inngest-style) — strongest typing, but the file becomes code: the UI cannot safely rewrite TS so the round-trip degrades to read-only or a code editor, and the orchestrator must evaluate operator code. A TS data module shares the write-path problem (code-gen on every UI edit).
- **Pure YAML** — one parser, but the prompt (the part the operator edits most) lives as a block scalar inside indentation-sensitive YAML.
- **Declarative per-trigger filter keys** (`label: ready`, `no-open-pr: true`) — rejected as a closed, invented vocabulary: every unforeseen filtering need becomes an engine change, violating the "expressible with no engine changes" acceptance bar, and it designs event shapes GitHub already designed.
- **Markdown + frontmatter, CEL selection** (chosen) — config gets strict schema validation, prompts get prose treatment, and selection binds to shapes that already exist.

## Consequences

- One expression language end to end: `if:` and `{{ }}` share the evaluator and the payload namespace; both are validated at parse time, before any agent runs. The CEL evaluator is an exact-pinned implementation behind a usine-owned seam (same policy as Pi and Effect workflow).
- Payload slices stay GitHub-shaped — the Triggers ticket defines only which graph edges each stream fetches; widening a slice is additive.
- The selector stays declarative (names/tags, intersection when both given) because the engine prunes polling by it; an expression would make repo scope opaque until evaluation.
- UI writes are surgical YAML-AST edits — comments, key order, and formatting survive; hand-authored files are never rewritten in the background.
- Strict validation with per-loop quarantine; an invalid `usine.yaml` (which carries the single factory-wide `version:`, the registry, and settings) is a factory-level error state.
- Field defaults keep ceremony out of v1 files: `step: run`, `approval: none`. (`enabled:` was dropped from the schema by [ADR 0016](./0016-config-editing-forms-first-preview-before-arming.md) — pause is runtime state per [ADR 0009](./0009-instance-repo-remote-optional-runtime-state.md), never a file field.)
