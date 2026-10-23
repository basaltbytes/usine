# @usine/expression

## 0.2.0

### Minor Changes

- b9e38a7: Moves expression schemas, environment descriptors, and typed errors from `/model` to `@usine/expression/expression-engine`; update your imports. GitHub contracts are reorganized without changing public entry points.

### Patch Changes

- 354e598: Creates declared GitHub labels before polling and warns when board lanes or loop triggers use undeclared labels. Label names allow at most 50 characters and no surrounding whitespace.

## 0.1.0

### Minor Changes

- 95b26af: Loads, validates, and edits the instance folder with per-loop quarantine and checked CEL prompts, and adds a typed CEL service over plain JSON.

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` contains the event, run, step, and attempt domain model, the run state machine, and the attempt failure kinds.
