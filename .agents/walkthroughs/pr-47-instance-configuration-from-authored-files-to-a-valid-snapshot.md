---
walkthrough: 1
title: Instance configuration from authored files to a valid snapshot
pr: 47
commit: c731c6b45493844c9f5811b41ed91f826ec5e020
meta:
  pr: "#47"
  commit: c731c6b
  scope: config, CEL, instance loading
  balade-authoring: 1.33.0
---

{% group label="Overview" %}
{% section id="overview" title="What changes for instance loading" icon="repo" %}
This PR adds the first complete instance-folder boundary. It parses `usine.yaml`, agent Markdown files, and loop Markdown files into strict domain values. It then returns one `LoadedInstance` snapshot. A factory config error stops the load. A file-owned agent or loop error stays in the snapshot, so valid sibling loops can still run.

The change also adds a typed CEL service. Loop trigger expressions must return a boolean. Prompt interpolations must return a scalar. Both forms are checked against the payload slice for the loop's stream before the loop enters the loaded set.

The main review questions are:

- Does each authored schema match the intended file contract?
- Does quarantine keep all invalid references out of `loaded.loops`?
- Do the issue, pull-request, and schedule descriptors expose the correct payload fields and CEL types?
- Do edits preserve the authored document details that the UI must round-trip?
{% /section %}
{% /group %}

{% group label="Typed CEL expressions" %}
{% section id="cel-contract" title="Backend-neutral check and evaluation contract" icon="code-square" related=["stream-slices","loop-parser"] %}
`ExpressionEngine` separates validation from evaluation and exposes only usine-owned values. A caller supplies a `Source`, an `Environment`, and plain JSON. The service returns typed check or evaluation errors. The contract does not expose the installed CEL library, so another layer can implement the same service tag.

{% code file="packages/expression/src/expression-engine.ts" from=10 to=34 expect="/** Backend-neutral CEL operations used by config parsing and prompt rendering. */" /%}

The live adapter builds a fresh CEL environment from declared object fields and root variables. It disables dynamic unlisted variables. This makes unknown roots and unknown object paths check failures instead of deferred runtime failures.

{% code file="packages/expression/src/marcbachmann-cel.ts" from=68 to=79 expect="const makeEnvironment = (descriptor: Environment): CelEnvironment => {" /%}

`checkExpected` also checks the expression's result type. Boolean triggers accept only `bool`. Prompt expressions accept CEL scalar types. Evaluation repeats the relevant check, evaluates normalized JSON, and decodes the result before it crosses the seam. JSON integers become `bigint` where CEL declares `int` or `uint`.

{% code file="packages/expression/src/marcbachmann-cel.ts" from=125 to=152 expect="const checkExpected = (" collapsed=true /%}

{% code file="packages/expression/src/marcbachmann-cel.ts" from=181 to=227 expect="const checkBoolean = Effect.fn(\"ExpressionEngine.checkBoolean\")(" collapsed=true /%}

{% tests %}
{% test name="typed CEL over plain JSON" kind="unit" ref="packages/expression/test/expression.test.ts" asserts=["checks and evaluates a macro expression", "rejects unknown roots and paths inside macro bodies", "rejects incompatible operands"] %}The adapter tests use the public service and live CEL layer rather than a module mock.{% /test %}
{% test name="result-shape enforcement" kind="unit" ref="packages/expression/test/expression.test.ts" asserts=["requires boolean trigger results", "requires scalar interpolation results", "translates parse failures"] %}The assertions distinguish parse, type, and unexpected-result failures.{% /test %}
{% /tests %}
{% /section %}

{% section id="stream-slices" title="Stream-specific payload namespaces" icon="stack" related=["cel-contract","loop-parser"] %}
The config package declares the CEL namespace for each stream. Every namespace has `repo` and `item` roots. The `item` type changes between the issue, pull-request, and schedule payload slices. `environmentFor()` is exhaustive over the three `Trigger["on"]` values.

The field declarations in this file are a load-bearing review surface. They determine which paths and types are accepted in both `trigger.if` and `{{ ... }}` expressions. The final assembly below shows which object descriptors each stream receives.

{% code file="packages/config/src/payload-slices.ts" from=162 to=227 expect="const environment = (types: ReadonlyArray<ObjectType>, itemType: string): Environment =>" /%}
{% /section %}
{% /group %}

{% group label="Strict parsing and quarantine" %}
{% section id="authored-model" title="Authored schemas become domain values" icon="database" related=["loop-parser","folder-load"] %}
`UsineConfig` requires `version: 1` and a managed-repo registry. It supplies defaults for settings, a local worker, disabled webhooks, and the optional operator. The schema rejects duplicate names and constrains names, repo identities, tags, positive limits, cron values, and IANA time zones.

The authored YAML uses snake_case. `Schema.encodeKeys` maps it once to camelCase domain fields. The same mapping supports encoding back to authored keys.

{% code file="packages/config/src/model.ts" from=100 to=161 expect="export class ManagedRepo extends Schema.Class<ManagedRepo>(\"@usine/config/ManagedRepo\")({" /%}

Loop and agent names come from their `.md` filenames. Loop defaults are `approval: none` and `step: run`. Schedule triggers use Effect's cron and named-zone parsers at schema construction.

{% code file="packages/config/src/model.ts" from=178 to=245 expect="// Validated by the same effect Cron parser the engine's scheduler evaluates" /%}

Selectors use intersection semantics across axes: a repo must match the explicit repo list *and* at least one requested tag when both are present. An omitted selector matches every managed repo.

{% code file="packages/config/src/selector.ts" from=4 to=19 expect="/** Match both selector axes when both are present; an omitted selector matches every repo. */" /%}
{% /section %}

{% section id="loop-parser" title="Loop validation follows its selected stream" icon="filter" related=["cel-contract","stream-slices","folder-load"] %}
The parser first splits Markdown frontmatter, parses strict YAML, and rejects excess properties. It derives identity from the filename. For a loop, it then selects the stream environment, checks `trigger.if` as boolean, finds every prompt interpolation, and checks each interpolation as scalar. Only then does it construct `LoopFile`.

```pseudo
parse loop file
  derive name from filename
  split frontmatter and body
  decode strict frontmatter
  select stream environment
  check trigger as boolean
  check each interpolation as scalar
  construct LoopFile
```

{% code file="packages/config/src/parser.ts" from=193 to=229 expect="const makeParseLoopFile = (engine: ExpressionEngine[\"Service\"]) =>" /%}

Prompt rendering reuses the loop's stream descriptor. It evaluates all interpolation spans and replaces only those spans in the Markdown body.

{% code file="packages/config/src/parser.ts" from=134 to=158 expect="const render = (" /%}
{% /section %}

{% section id="folder-load" title="One factory boundary, per-file quarantine" icon="workflow" related=["authored-model","loop-parser","reference-integrity"] %}
`InstanceFolder.load()` treats `usine.yaml` as the factory boundary. A read or parse failure there becomes `FactoryConfigError`. After that boundary succeeds, the loader reads agent and loop directories in parallel. It sorts Markdown filenames and parses up to 16 files concurrently per directory.

```mermaid
flowchart TD
  root[Instance directory] --> factory[Parse usine.yaml]
  factory -->|failure| stop[FactoryConfigError]
  factory -->|success| files[Parse agents and loops]
  files --> agents[Valid and invalid agents]
  files --> refs[Build reference index]
  refs --> loops{Loop valid and resolved?}
  loops -->|yes| loaded[Loaded loops]
  loops -->|no| quarantine[Quarantined loops]
  agents --> snapshot[LoadedInstance]
  loaded --> snapshot
  quarantine --> snapshot
```

A malformed agent enters `invalidAgents`. A malformed loop enters `quarantinedLoops`. A parsed loop is checked against the valid agent roster and registry before it enters `loops`. The loader then constructs the aggregate from all five result sets.

{% code file="packages/config/src/instance-folder.ts" from=95 to=155 expect="      return {" /%}
{% /section %}

{% section id="reference-integrity" title="The snapshot enforces reference integrity" icon="shield-check" related=["folder-load"] %}
Reference checking has one pure owner. It rejects an unknown agent, an unknown selected repo, or an unknown selected tag with a file-owned `reference` error. The loader uses that error for quarantine.

`LoadedInstance` applies the same rule as a construction invariant. Code cannot construct a snapshot whose `loops` refer outside its loaded roster or registry, even if it bypasses `InstanceFolder.load()`.

{% code file="packages/config/src/model.ts" from=269 to=335 expect="export const referenceIndex = (" /%}

{% tests %}
{% test name="acceptance instance load" kind="unit" ref="packages/config/test/config.test.ts" asserts=["loads the three acceptance loops", "quarantines a bad CEL path", "quarantines an unknown agent", "records an invalid agent"] %}The fixture exercises the complete filesystem, parser, live CEL layer, and aggregate path.{% /test %}
{% test name="factory and aggregate boundaries" kind="unit" ref="packages/config/test/config.test.ts" asserts=["fails an invalid usine.yaml as FactoryConfigError", "rejects construction with an unrostered agent"] %}These tests distinguish fatal factory state from file quarantine and prove the aggregate invariant.{% /test %}
{% test name="schedule and selector rules" kind="unit" ref="packages/config/test/config.test.ts" asserts=["rejects an invalid cron range", "defaults the schedule zone to UTC", "requires both selector axes"] %}The tests cover rules that are easy to weaken during parser changes.{% /test %}
{% /tests %}
{% /section %}
{% /group %}

{% group label="Round-trip editing and shared vocabulary" %}
{% section id="yaml-editing" title="Surgical YAML and frontmatter edits" icon="pencil" %}
The writer parses YAML into a token-preserving document AST and updates one non-empty path. `updateFrontmatter()` changes only the YAML half and appends the original Markdown body unchanged.

The AST stringifier always emits LF, so newline restoration has one owner: `restoreNewlines` normalizes and re-applies the authored style. `updateYaml()` detects the style from its source; `updateFrontmatter()` applies the file's delimiter style, which also covers a one-line YAML half that carries no newline of its own.

{% code file="packages/config/src/yaml/writer.ts" from=6 to=43 expect="export class YamlEdit extends Schema.Class<YamlEdit>(\"@usine/config/YamlEdit\")({" /%}

{% tests %}
{% test name="document-preserving edits" kind="unit" ref="packages/config/test/config.test.ts" asserts=["keeps comments", "keeps key order", "keeps the Markdown body", "does not accept a delimiter-prefix line as the closing delimiter"] %}The tests cover the authored-text preservation rules through the public writers.{% /test %}
{% test name="CRLF round-trip" kind="unit" ref="packages/config/test/config.test.ts" asserts=["retains CRLF in a standalone YAML edit", "retains CRLF in a frontmatter edit"] %}Guards the regression where the AST stringifier silently renormalized a CRLF-authored file to LF on its first edit.{% /test %}
{% /tests %}
{% /section %}

{% section id="shared-vocabulary" title="Core owns instance and approval types" icon="link" %}
`@usine/core` now owns the branded instance directory and the approval literal set. The config loader consumes these types directly. The engine keeps its existing public names as aliases to the core values, so its database and submission model use the same runtime schema and TypeScript type.

{% code file="packages/core/src/lifecycle/loop.ts" from=11 to=18 expect="/**" /%}

{% code file="packages/engine/src/model.ts" from=4 to=11 expect="/** Whether a loop parks new runs until an approval Event arrives. */" /%}
{% /section %}
{% /group %}

{% group label="Full PR diff" %}
{% section id="full-pr-diff" title="Full PR diff" icon="file-diff" %}
{% files %}
{% filegroup label="Configuration loader" only="{packages/config/src/**,packages/config/README.md,packages/config/package.json,packages/config/tsconfig.check.json}" /%}
{% filegroup label="CEL seam" only="{packages/expression/src/**,packages/expression/README.md,packages/expression/package.json,packages/expression/tsconfig.check.json}" /%}
{% filegroup label="Tests and fixtures" only="{packages/config/test/**,packages/expression/test/**}" /%}
{% filegroup label="Shared domain" only="{packages/core/**,packages/engine/src/model.ts}" /%}
{% filegroup label="Release and workspace" only="{.changeset/**,AGENTS.md,pnpm-lock.yaml}" /%}
{% /files %}
{% /section %}
{% /group %}
