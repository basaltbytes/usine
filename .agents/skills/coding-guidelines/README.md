# coding-guidelines

The basaltbytes practices charter, shipped as a skill. [CODING_GUIDELINES.md](CODING_GUIDELINES.md)
covers always-valid domain modeling (section 1), functional-core architecture,
error discipline, workflow/idempotency, observability, testing, and hygiene.
[SKILL.md](SKILL.md) is the trigger that pulls agents into the charter on demand;
language mappings for section 1 live in [PYTHON.md](PYTHON.md) (pydantic v2 strict)
and [TYPESCRIPT.md](TYPESCRIPT.md) (Zod).

## Sources, inspiration, literature

The five rules braid four traditions together: classic DDD, the typed-functional
school, Design by Contract, and the refactoring smell catalog.

### 1. Name the concept, not the primitive

- Martin Fowler (with Kent Beck), [*Refactoring*](https://martinfowler.com/books/refactoring.html)
  (1999; 2nd ed. 2018) — names the **Primitive Obsession** smell.
- Eric Evans, [*Domain-Driven Design*](https://www.domainlanguage.com/ddd/) (2003) —
  the Value Object as a carrier of domain meaning.
- Ward Cunningham, [The CHECKS Pattern Language of Information Integrity](https://c2.com/ppr/checks.html)
  (PLoP 1994) — the **Whole Value** pattern, deep ancestor of "a date and a valid date
  are two different concepts".

### 2. Validate at construction, once

- Eric Evans, *DDD* (2003) — invariants held by constructors and factories.
- Vaughn Vernon, [*Implementing Domain-Driven Design*](https://www.informit.com/store/implementing-domain-driven-design-9780321834577)
  (2013) — self-validating Value Objects and guard clauses.
- Greg Young, "Always Valid" (2009) — the blog post that named the always-valid camp;
  the original is offline, but Vladimir Khorikov's
  [Always-valid domain model](https://enterprisecraftsmanship.com/posts/always-valid-domain-model/)
  (2020) carries the argument forward.
- Bertrand Meyer, [*Object-Oriented Software Construction*](https://en.wikipedia.org/wiki/Object-Oriented_Software_Construction)
  (1988/1997) — the class invariant of Design by Contract: established at
  construction, preserved by every public method.

### 3. Parse, don't validate

- Alexis King, [Parse, don't validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/)
  (2019) — the canonical essay.
- Edwin Brady, [*Type-Driven Development with Idris*](https://www.manning.com/books/type-driven-development-with-idris)
  (2017) — types as preservation of the proof obtained at parsing.

### 4. Trust the interior

- Bertrand Meyer, *OOSC* — the **non-redundancy principle**: a routine body never
  retests its own precondition; the canonical argument against defensive revalidation.
- Andy Hunt & Dave Thomas, [*The Pragmatic Programmer*](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/)
  (1999; 20th-anniversary ed. 2019) — Design by Contract, "Dead Programs Tell No Lies".
- Jim Shore, [Fail Fast](https://www.martinfowler.com/ieeeSoftware/failFast.pdf)
  (IEEE Software, 2004).
- Dan Bergh Johnsson, Daniel Deogun & Daniel Sawano,
  [*Secure by Design*](https://www.manning.com/books/secure-by-design) (2019) — their
  **domain primitives** are rules 1 + 2 + 4 combined, with the security argument on
  top. The single closest book to this skill.

### 5. Make illegal states unrepresentable

- Yaron Minsky, [Effective ML](https://blog.janestreet.com/effective-ml-revisited/)
  (~2010) — coined the phrase, OCaml side.
- Scott Wlaschin, [*Domain Modeling Made Functional*](https://pragprog.com/titles/swdddf/domain-modeling-made-functional/)
  (2018) and the [Designing with types](https://fsharpforfunandprofit.com/series/designing-with-types/)
  series — the bridge between DDD and sum types.
- Richard Feldman, [Making Impossible States Impossible](https://www.youtube.com/watch?v=IcgmSRJHu_8)
  (elm-conf 2016) — the frontend rendition.

### Tooling

- [Zod](https://zod.dev) — parse-don't-validate for TypeScript boundaries, branded types.
- [pydantic v2](https://docs.pydantic.dev) — strict-mode validated construction for Python.
