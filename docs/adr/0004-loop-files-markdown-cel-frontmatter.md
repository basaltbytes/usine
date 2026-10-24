# Loop files are Markdown with CEL-filtered frontmatter

A loop file is `loops/<name>.md` in the instance repo: YAML frontmatter for structured settings (trigger, selector, approval, step, agent slot), and the Markdown body as prompt template. The trigger sets a stream (`on:`). All item selection is a CEL expression (`if:`) over a per-stream GraphQL slice of GitHub's object graph. The body can interpolate `{{ }}` over the same CEL namespace, after an always-prepended preamble with repo and payload.

## Considered options

- **TypeScript DSL** (Inngest-style): strongest typing, but the file is code: the UI can't safely rewrite it (read-only or a code editor), and the orchestrator must run operator code. A TypeScript data module needs code generation on every UI edit.
- **Pure YAML**: one parser, but the prompt, the most-edited part, is a block scalar in indentation-sensitive YAML.
- **Per-trigger filter keys** (`label: ready`, `no-open-pr: true`): a closed, invented vocabulary. Each new filter is an engine change, failing the "expressible with no engine changes" bar, and it redesigns GitHub's event shapes.
- **Markdown, frontmatter, and CEL selection** (chosen): schema-validated config, prose prompts, and selection over existing shapes.

## Consequences

- `if:` and `{{ }}` share one evaluator and payload namespace, validated at parse time. The CEL evaluator is exact-pinned behind a usine seam.
- Payload slices keep GitHub's shapes. The Triggers ticket only picks each stream's graph edges, and widening is additive.
- The selector stays declarative (names or tags, intersected if both): the engine prunes polling by it, and an expression would hide repo scope until evaluated.
- UI writes edit the YAML AST in place, keeping comments, key order, and formatting. Nothing rewrites hand-authored files in the background.
- Validation is strict, and an invalid loop is quarantined alone. An invalid `usine.yaml` (instance-wide `version:`, registry, settings) is an instance-level error.
- Short defaults: `step: run`, `approval: none`. ([ADR 0016](./0016-config-editing-forms-first-preview-before-arming.md) removed `enabled:`: pause is runtime state per [ADR 0009](./0009-instance-repo-remote-optional-runtime-state.md), never a file field.)
