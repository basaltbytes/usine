# @usine/expression

Typed CEL checking and evaluation for [usine](https://github.com/basaltbytes/usine). Callers describe object types and root variables with `Environment`, then use `ExpressionEngine` to check boolean trigger expressions, check scalar prompt expressions, or evaluate either form over plain JSON.

An `ObjectField` marked `nullable` can hold `null`, and an absent key reads as `null`: expressions compare it with `null` in either order, and paths below it stay type-checked. Unknown variables and object paths fail during checking, including paths inside CEL macros such as `exists`. Failures are typed values: `ExpressionCheckError` from parsing, type checking, or result-type checking, `ExpressionEvaluationError` from evaluation, and the `ExpressionError` union covering both. JSON integers declared as CEL `int` or `uint` are converted to `bigint` before evaluation so GraphQL payloads keep CEL integer semantics.

Expressions can use CEL optional types: `.?` and `[?]` selection, and `optional` helpers such as `orValue`. `item.?milestone.?title.orValue("none")` reads `"none"` when `milestone` is null or absent, and `map.?key` reads no value for an absent key. A null field counts as present, so `item.?milestone` holds `null`, not an empty optional.

`relatedStringLiterals(source, memberPath)` reports string literals from the smallest expression subtrees that use a member path. It parses with the same CEL options as checking, so an expression using `.?` is analyzed too. Config validation uses it to diagnose undeclared GitHub labels without coupling `@usine/config` to the CEL adapter's AST.

`MarcbachmannCelLayer` uses `@marcbachmann/cel-js@8.0.0`. The exported `ExpressionEngine` contract contains CEL type names and usine-owned descriptors rather than library objects; an `@bufbuild/cel` adapter can provide the same service tag without changing callers.

All APIs remain 0.x and can change between minor releases.

Import `ExpressionEngine`, `Source`, `Environment`, the environment descriptors,
`Scalar`, and the typed expression errors from `@usine/expression/expression-engine`.
This entry point replaces `@usine/expression/model`; existing imports from that
subpath must use `/expression-engine`. Import the CEL adapter layer separately
from `@usine/expression/marcbachmann-cel`.
