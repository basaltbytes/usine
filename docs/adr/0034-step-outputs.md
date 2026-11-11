# Step outputs are JSON documents stored separately from step results

An attempt can return a document, such as a compiled walkthrough, that later steps and readers need after its checkout is removed. The agent writes a typed JSON envelope to `.usine/outputs/<name>.json`, and the executor collects it through the checkout's command runner after the attempt reports. Git excludes `.usine/` from commits and salvage. Output types are opaque strings that the agent chooses.

`StepResult.outputs` holds only refs: name, type, optional commit, size, and SHA-256. Bodies are gzip-compressed in their own table behind the `StepOutputStore` port, because run reads load the step result often. The attempt's durable record keeps the full documents, so a restart after collection can store them without the checkout. The engine writes the bodies before it records the attempt's end, idempotently by attempt and name, and reads return only outputs of succeeded attempts. This avoids a transaction across two stores.

## Considered options

- **Final-answer markers**: the model would reproduce a document of a megabyte or more as output tokens.
- **Bodies in the step result**: every run read would carry them.
- **A catalog of output types**: the engine would maintain a list of what agents produce.
