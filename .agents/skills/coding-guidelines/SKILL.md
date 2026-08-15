---
name: coding-guidelines
description: Basaltbytes coding-guidelines charter — always-valid domain modeling, functional-core architecture, typed-error discipline, idempotent workflows, observability, test economy and real seams, and hygiene. Use when designing or reviewing domain models, value objects, or state machines, when parsing at API/DB/env boundaries (pydantic strict, Zod, branded/newtype ids), when structuring error handling, when deciding whether a change needs tests (or has dead ones to delete) or choosing test seams and mocks, or when code shows primitive obsession, validation inside function bodies, scattered rechecks, assert/non-null narrowing, or raw payloads flowing into domain functions.
---

# Coding Guidelines

The charter lives in [CODING_GUIDELINES.md](CODING_GUIDELINES.md), shipped with this
skill — read the sections the task touches. For domain modeling, section 1 is the
law: read it with its review checklist and Final check, then follow its
language-mapping pointer ([PYTHON.md](PYTHON.md) / [TYPESCRIPT.md](TYPESCRIPT.md))
for the code at hand.
