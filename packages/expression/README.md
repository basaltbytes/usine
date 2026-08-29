# @usine/expression

Typed CEL checking and evaluation for [usine](https://github.com/basaltbytes/usine). Callers describe object types and root variables with `Environment`, then use `ExpressionEngine` to check boolean trigger expressions, check scalar prompt expressions, or evaluate either form over plain JSON.

Unknown variables and object paths fail during checking, including paths inside CEL macros such as `exists`. Failures are typed values: `ExpressionCheckError` from parsing, type checking, or result-type checking, `ExpressionEvaluationError` from evaluation, and the `ExpressionError` union covering both. JSON integers declared as CEL `int` or `uint` are converted to `bigint` before evaluation so GraphQL payloads keep CEL integer semantics.

`MarcbachmannCelLayer` uses `@marcbachmann/cel-js@8.0.0`. The exported `ExpressionEngine` contract contains CEL type names and usine-owned descriptors rather than library objects; an `@bufbuild/cel` adapter can provide the same service tag without changing callers.

All APIs remain 0.x and can change between minor releases.
