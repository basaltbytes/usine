# @usine/expression

Typed CEL checking and evaluation for [usine](https://github.com/basaltbytes/usine). Describe types and root variables with `Environment`. `ExpressionEngine` then checks boolean trigger, integer priority, and scalar prompt expressions, and evaluates them over plain JSON.

Import `ExpressionEngine`, `Source`, `Environment`, the environment descriptors, `Scalar`, and the typed errors from `@usine/expression/expression-engine`, which replaces `@usine/expression/model`. The CEL adapter layer is in `@usine/expression/marcbachmann-cel`. That subpath also exports `makeExpressionEngine()` for callers that supply the service explicitly without a layer.

A `nullable` `ObjectField` can be `null`, and an absent key reads as `null`. Expressions compare it with `null` in either order, and paths below it stay type-checked. Unknown variables and paths fail checking, also inside macros such as `exists`.

Typed `map<string,T>` fields accept JSON object values. Reads through a map keep
`T`'s field checks, nullable-field handling, and integer normalization.

Expressions can use CEL optional values: `.?` and `[?]` select a value that might be missing, and `optional` helpers such as `orValue` give a fallback. `item.?milestone.?title.orValue("none")` is `"none"` if `milestone` is null or absent. A null field counts as present, so `item.?milestone` holds `null`, not an empty optional.

Errors: `ExpressionCheckError` (parse, type, or result type), `ExpressionEvaluationError`, and the union `ExpressionError`. JSON integers declared as CEL `int` or `uint` become `bigint` before evaluation, so GraphQL payloads keep CEL integer semantics.

`relatedStringLiterals(source, memberPath)` returns string literals from the smallest subtrees that use a member path. It accepts the same syntax as the checks, including `.?`. Config validation uses it to report undeclared labels without depending on the CEL AST.

`MarcbachmannCelLayer` uses `@marcbachmann/cel-js@8.0.0`. The contract uses CEL type names and usine descriptors, not library objects; an `@bufbuild/cel` adapter can provide the same tag.

The 0.x APIs can change between minor releases.

`checkInteger` requires a CEL `int` result. `evaluateInteger` checks and evaluates it as a `bigint`, preserving precision; consumers apply their own numeric range constraints.
