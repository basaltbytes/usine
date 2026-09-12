# @usine/expression

## 0.2.0

### Minor Changes

- b9e38a7: Import expression schemas, environment descriptors, and typed errors from
  `@usine/expression/expression-engine`. This replaces the `/model` entry point;
  update existing `/model` imports to `/expression-engine`.
  
  Organize GitHub authentication, access, polling, and operator view contracts by
  responsibility while preserving their existing public entry points and schemas.

### Patch Changes

- 354e598: Provision factory-wide GitHub label declarations before polling, report non-blocking preflight failures, and warn when Board lanes or Loop triggers use undeclared labels. Label names follow GitHub's contract (at most 50 characters, no surrounding whitespace), and provisioning waits for a confirmed catalog instead of creating labels blindly after a failed catalog request.

## 0.1.0

### Minor Changes

- 95b26af: Load, validate, and edit instance-folder configuration with per-loop quarantine and checked CEL prompt rendering. Add a typed CEL service over plain JSON with an implementation-neutral environment contract.

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` ships the Event → Run → Step → Attempt domain model: branded ids, the typestate run state machine (pending → waiting → running → succeeded / failed / canceled), and the attempt-failure taxonomy (infra / agent / runaway) with the auto-retry law. The other eight blocks reserve their seams while the engine grows.
