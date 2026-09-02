# @usine/expression

## 0.1.0

### Minor Changes

- 95b26af: Load, validate, and edit instance-folder configuration with per-loop quarantine and checked CEL prompt rendering. Add a typed CEL service over plain JSON with an implementation-neutral environment contract.

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` ships the Event → Run → Step → Attempt domain model: branded ids, the typestate run state machine (pending → waiting → running → succeeded / failed / canceled), and the attempt-failure taxonomy (infra / agent / runaway) with the auto-retry law. The other eight blocks reserve their seams while the engine grows.
