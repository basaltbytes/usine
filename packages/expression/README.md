# @usine/expression

Typed CEL checking and evaluation for [usine](https://github.com/basaltbytes/usine). Describe types and root variables with `Environment`. `ExpressionEngine` then checks boolean trigger and scalar prompt expressions, and evaluates them over plain JSON.

Import `ExpressionEngine`, `Source`, `Environment`, the environment descriptors, `Scalar`, and the typed errors from `@usine/expression/expression-engine`, which replaces `@usine/expression/model`. The CEL adapter layer is in `@usine/expression/marcbachmann-cel`.

A `nullable` `ObjectField` can be `null`, and an absent key reads as `null`. Expressions compare it with `null` in either order, and paths below it stay type-checked. Unknown variables and paths fail checking, also inside macros such as `exists`.

Expressions can use CEL optional types: `.?` and `[?]` selection, and `optional` helpers such as `orValue`. `item.?milestone.?title.orValue("none")` is `"none"` if `milestone` is null or absent, and `map.?key` has no value if the key is absent. A null field counts as present, so `item.?milestone` holds `null`, not an empty optional.

Errors: `ExpressionCheckError` (parse, type, or result type), `ExpressionEvaluationError`, and the union `ExpressionError`. JSON integers declared as CEL `int` or `uint` become `bigint` before evaluation, so GraphQL payloads keep CEL integer semantics.

`relatedStringLiterals(source, memberPath)` returns string literals from the smallest subtrees that use a member path. It parses with the same CEL options as checking, so an expression that uses `.?` is analyzed too. Config validation uses it to report undeclared labels without depending on the CEL AST.

`MarcbachmannCelLayer` uses `@marcbachmann/cel-js@8.0.0`. The contract uses CEL type names and usine descriptors, not library objects; an `@bufbuild/cel` adapter can provide the same tag.

The 0.x APIs can change between minor releases.
