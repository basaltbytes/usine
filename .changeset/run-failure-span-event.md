---
"@usine/engine": patch
---

When a run's fiber stops on an engine failure, `The Run's fiber stopped on an engine failure` is now logged inside the run's `RunDriver.drive` span, so it appears as a span event in the run's trace, and the span ends with the failure. Before, the line was logged under the `RunDriver.launch` span, which had already ended.
