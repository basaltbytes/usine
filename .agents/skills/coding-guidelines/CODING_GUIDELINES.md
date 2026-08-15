# Coding Guidelines

The practices enforced in basaltbytes codebases — for humans and agents alike. Each
rule is a commitment, not a suggestion: apply it when writing, hunt violations when
reviewing. Sources are on the [bookshelf](README.md); the [coding-guidelines
skill](SKILL.md) ships this file and pulls agents into it on demand.

## When rules conflict

Earlier wins:

1. Correctness, safety, debuggability.
2. The codebase's established architecture and conventions.
3. Moving the local design toward these guidelines.
4. No broad migrations unless explicitly requested.
5. Trade-offs worth remembering get written down (comment or ADR).

New modules follow the guidelines in full; existing code is improved
opportunistically, not rewritten wholesale on an unrelated change.

## Economy of change

- **Code is spent, not produced** (Dijkstra). The right diff is the smallest honest
  one — measured in blast radius (files, modules, behaviors touched), not just
  lines.
- **YAGNI.** Build for the requirement in front of you; presumptive generality pays
  build, carry, and repair costs before anyone needs it. An abstraction, parameter,
  or hook with one caller and no second in sight is speculation — inline it.
- **Duplication is cheaper than the wrong abstraction** (Metz). Tolerate a second
  copy until a third reveals the real shape; unwinding a wrong abstraction costs
  more than the copies ever did.
- **Big changes decompose.** Make the change easy, then make the easy change (Beck):
  preparatory refactoring lands separately from the behavior change, each step
  reviewable and revertible on its own.

## 1. Domain integrity (always-valid)

A constructed domain object is a proof. If an instance exists, it is valid — shape and
invariants. Validation happens exactly once, at construction; every function that
receives a domain type trusts it and never revalidates.

Type annotations are not runtime guarantees. In Python and TypeScript the checker stops
at unchecked call-sites, `JSON.parse`, ORM rows, env vars, and third-party input.
Construction-time validation is what makes the annotation true past that point.

1. **Name the concept, not the primitive.** A date and "a valid billing period" are
   different concepts. Any value carrying a domain constraint gets its own type
   (value object, newtype, branded type). `f(start: date, end: date)` hides an
   invariant; `f(period: Period)` carries it. Two sibling concepts never share one
   primitive type. Identifiers included: `pay(to: CustomerId)` cannot be called with
   two swapped strings; `pay(to: string)` can. A branded id helper that exists but
   isn't used is worse than none — wire it or delete it.

2. **Validate at construction, once.** The constructor (or factory) enforces shape
   AND semantic invariants — non-empty, ordered, timezone-aware, in-range. An invalid
   instance must be unconstructible, and a test proves construction fails.

3. **Parse, don't validate.** At system edges — HTTP bodies, DB rows, webhooks
   (verify the signature first), files, messages — parse raw data INTO domain types.
   Environment too: `process.env` / `os.environ` is parsed once at boot into a typed
   config object; nothing reads env ad hoc past that point. Errors surface at the
   edge, in the edge's error vocabulary (400, MalformedX). Past the edge, signatures
   accept only domain types.

4. **Trust the interior.** A value object carries its proof; a recheck throws that
   proof away (Meyer's non-redundancy principle). Composition takes validated
   children as-is — an entity accepting a `Member` never runs `Member.parse` again.
   Defensive revalidation says construction isn't trusted: fix construction, delete
   the recheck.

5. **Make illegal states — and illegal transitions — unrepresentable.** Distinct
   states are distinct types (discriminated unions, sum types), each carrying exactly
   its own data — not one type with a status enum plus optional fields for every
   state's baggage. Transitions are typestate: the guard and the mutation are one
   operation (`cancel()` exists only on a state that can be cancelled), never a
   predicate the caller must remember to call before mutating. If a function needs
   `assert x is not None` or a non-null `!`, the state model is wrong: introduce the
   type in which `x` cannot be null.

### Review checklist — hunt these

- Primitive obsession: `str`/`int`/`float`/`date` parameters carrying implicit
  constraints (ids, emails, money, quantities, ranges).
- Validation logic inside function bodies instead of constructors.
- Scattered `isinstance` / `typeof` / `instanceof` rechecks deep in domain code.
- `assert x is not None` (vanishes under `python -O`) or TypeScript `x!` — type-level
  trust dressed as a check.
- Subclass traps passing silently: `datetime` is-a `date`, `bool` is-an `int` (Python).
- Boundary data flowing into domain signatures without a parse step: `as X` casts,
  raw `dict` access, unvalidated ORM/JSON payloads.
- Scattered `status === "..."` narrowing in place of distinct state types.
- A constructor that stores whatever it is given.

### Language mappings

Working in one of these languages? Read its mapping (shipped next to this file)
before writing code.

- Python → [PYTHON.md](PYTHON.md) — pydantic v2 strict, nominal wrappers, rejection tests.
- TypeScript → [TYPESCRIPT.md](TYPESCRIPT.md) — Zod at the edges, branded types, discriminated unions.

### Final check

Done means every domain value, boundary, and state transition in scope was walked
against the five rules — each one passes or carries a flagged fix. A clean verdict
names what was walked.

## 2. Architecture: functional core, imperative shell

- **The domain core is pure.** Entities, value objects, and derivers (pure
  decision/derivation functions) perform no IO — no repository, no clock, no network.
  Time and randomness enter as parameters.
- **Use-cases orchestrate, domain objects decide.** The use-case shape is: load
  through a port → invoke pure domain logic → persist through a port → emit events.
  Business rules do not accumulate inline in use-cases; when one appears, move it
  onto the entity or a deriver where it can be tested pure.
- **Ports and adapters.** The domain package owns its interfaces (repositories,
  event emitters, providers); infrastructure implements them. Domain code never
  imports an ORM, an HTTP client, or a vendor SDK.
- **Depend on the narrowest interface, implement the widest adapter.** A consumer
  declares only the operations it actually calls; one wider concrete adapter can
  satisfy many narrow interfaces. This kills the mega-repository and one-method
  adapter sprawl at the same time.
- **Audit before creating an adapter or service.** Reuse an existing one as-is,
  then extend one whose capability the new method belongs to, then — last — create
  new, with an ADR naming what was audited and why reuse didn't fit.
- **Anti-corruption layers work in both directions.** A connector that parses
  third-party payloads into domain types on the way in, but returns the vendor's raw
  response (or `any`) on the way out, is half an ACL. Translate both payloads and
  **errors**, both directions, at the connector — vendor shapes and vendor exceptions
  never cross into domain code.
- **Separate reads from writes (CQRS-light).** State changes go through entities and
  repositories; list/detail reads go through query ports returning flat DTOs. The
  asymmetry is deliberate — write-side rows are rebuilt into validated domain
  objects, read-side DTOs stay cheap — but it is a *decision*: document it, don't
  drift into it.
- **Side effects ride domain events.** Emails, calendar syncs, analytics: emitted as
  typed events from use-cases, consumed by handlers at the edge. The domain never
  sends an email.
- **Modules are deep.** A module earns its existence by hiding complexity behind a
  smaller interface. The deletion test: if inlining a module makes its complexity
  vanish, it was pass-through waste; if deleting it spreads complexity across
  callers, it was earning its keep.
- **Import time is inert.** Importing a module never starts a server, opens a
  connection, reads env, or registers handlers; resource lifecycle belongs to the
  entrypoint/composition root. No mutable singletons — constants and pure lookup
  tables are fine.

## 3. Errors

- **One error dialect per codebase.** Throwing smart constructors, or
  Result-returning ones — either is defensible; pick one and enforce it everywhere.
  Two dialects bridged with adapters is debt; three is an incident. A dead in-house
  Result type next to a library one is the warning sign.
- **Errors are part of the signature.** A fallible operation's return type names its
  failure modes (typed error unions). `Promise<T>` that might throw anything is a
  signature that lies.
- **Defects are not failures.** Expected failures — domain, parsing, authorization,
  integration — are values in the return type. Violated invariants, impossible
  branches, and startup misconfiguration are defects: they panic through shared
  never-returning helpers (`casesHandled`, `shouldNeverHappen`), and nothing
  catches them to continue.
- **Translate at every layer boundary.** Validation-library errors (ZodError,
  ValidationError) are edge vocabulary — map them at the edge (400 + field errors);
  domain code never imports them. Same for vendor/provider errors → the domain's own
  error types, and domain errors → HTTP codes at the route.
- **Never swallow.** `catch → log → return null` converts a failure into a lie the
  caller can't see. Propagate a typed error or crash; `// TODO: handle errors` does
  not ship.

## 4. Workflows, transactions, idempotency

- **One boundary, one transaction.** Simple operations are plain function calls or
  a single database transaction. Never hold a transaction open across a network
  call or anything long-running.
- **Sagas and durable workflows are for genuine coordination** — retries,
  compensation, resumability, timers, human approval, multiple transaction
  boundaries — not the default shape of every use-case.
- **Anything that can be retried is explicitly idempotent.** Idempotency key,
  natural unique constraint, deduplication record, state-transition guard, or
  transactional outbox — chosen and named in the design, never "probably safe to
  run twice."

## 5. Observability and secrets

- **Failures are diagnosable from safe fields.** Structured tracing across
  requests, jobs, and adapter calls: domain ids, operation and provider names,
  state and error tags, retry counts. If diagnosing requires logging a raw payload,
  the trace fields are wrong — fix the fields.
- **Secrets never reach errors, logs, traces, or snapshots.** Tokens, keys, and
  credentials are wrapped in a `Redacted`-style type at the boundary and unwrapped
  only inside the adapter that spends them.

## 6. Testing

- **Every test names the regression it catches.** Before adding a test, identify
  the realistic regression it would catch and why existing coverage would miss
  it. A test justified only by coverage, symmetry, or "the code changed" is a
  dead test: do not add it, and delete it when you find one in review.
- **A bug fix comes with a regression test.** Write it at the level where the
  bug was observed, when practical. It fails before the fix and passes after.
- **Test absence only where absence is a contract** — a current API, security,
  or persistence guarantee. A removal deletes its tests. A test that verifies
  removed code, routes, or fields stay absent is a tombstone test; delete it.
- **Extend existing tests before creating new ones.** Add assertions to the
  existing test at the same behavior boundary. New files, fixtures, helpers, and
  snapshots need the same justification as new production code; test
  infrastructure stays simpler than the behavior it verifies.
- **Test through real seams.** Constructor-injected fakes, in-memory adapters, a
  local database — never module mocking (`vi.mock`, `jest.mock`,
  `unittest.mock.patch`). Code that can only be tested by patching its imports is
  missing a seam — fix the design, not the test.
- **Assert behavior, not interactions.** Returned value or typed error, persisted
  state, emitted event, rendered response, the message sitting in a fake adapter.
  Spy assertions (`toHaveBeenCalledWith`) only when the call itself is the
  observable outcome. A test that breaks on a behavior-preserving refactor is
  asserting implementation details: literal values, mappings, control flow.
- **Property tests where properties beat examples** — parsers, smart constructors,
  state machines, serialization roundtrips, normalization idempotence (fast-check,
  Hypothesis). Arbitraries live next to the domain module they generate.
- **Tests never bypass construction.** Fixtures go through the same parsers and
  smart constructors as production code; a test that hand-builds an invalid
  instance is exercising a world the domain forbids.

### Final check

Done means every test the change adds or modifies names its regression, and
every removal left no tests behind: none orphaned, none asserting absence.

## 7. Hygiene

- **No dead abstractions.** An unused base class, an unwired helper, a legacy
  duplicate of a library type — delete them. Dead code documents a decision nobody
  made; the next reader will trust it.
- **A change deletes what it orphans.** Replacing an implementation, a flag, or a
  branch is not done until the old one is gone — no superseded function left "just in
  case", no dead conditional, no commented-out block, no now-unreferenced import or
  helper. Version control is the safety net; the working tree carries only live code.
- **Unknown keys are errors in domain schemas.** Default strip-mode silently discards
  typos and stale fields. Domain-owned schemas are strict; lenient/strip mode is
  reserved for ACL ingestion, where third parties may add fields.
- **No narrowing lies in domain code.** `as X` casts and non-null `!` assertions
  assert what the runtime never checked. If the type system can't see it, restructure
  so it can (parse, variant types, exhaustive switch) — don't overrule it.
- **No behavior-switching boolean parameters.** `createUser(input,
  {emailVerification: "skip"})`, not `createUser(input, true)` — the call-site says
  what it does. Booleans stay fine as predicate returns.
- **No optional bags as inputs.** `Partial<T>` and nullable-everything parameters
  push branching into every callee. Each operation declares exactly the shape it
  requires; optionality is resolved by the caller — unless partiality is the actual
  domain concept.
- **Consistency across siblings is a feature.** A rule applied in one package applies
  in all of them, or the divergence is written down. Reviewers flag asymmetry
  (package A revalidates, package B trusts; package A returns Results, package B
  throws) even when each side works locally.

## Sources

The full annotated bookshelf lives in [README.md](README.md). Beyond it, the
practices in sections 2–7 draw on:

- Kent Beck, [make the change easy, then make the easy change](https://x.com/kentbeck/status/250733358307500032)
  (2012) — decomposing a big change into small revertible steps.
- Gary Bernhardt, [Boundaries](https://www.destroyallsoftware.com/talks/boundaries)
  (2012) — functional core, imperative shell.
- Alistair Cockburn, [Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture/)
  (2005) — ports and adapters.
- Edsger W. Dijkstra, [EWD1036](https://www.cs.utexas.edu/~EWD/transcriptions/EWD10xx/EWD1036.html)
  (1988) — "if we wish to count lines of code, we should not regard them as *lines
  produced* but as *lines spent*."
- Eric Evans, *Domain-Driven Design* (2003), part IV — anti-corruption layer and
  strategic design.
- Martin Fowler, [Yagni](https://martinfowler.com/bliki/Yagni.html) (2015) — the four
  costs of presumptive features.
- Google Engineering Practices, [Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html)
  — small changes review faster, bisect cleaner, roll back safer.
- Pat Helland, [Life beyond Distributed Transactions](https://queue.acm.org/detail.cfm?id=3025012)
  (CIDR 2007) — idempotency and coordination without distributed transactions.
- Vladimir Khorikov, [*Unit Testing Principles, Practices, and Patterns*](https://www.manning.com/books/unit-testing)
  (2020) — observable behavior over implementation details; which test doubles earn
  their keep.
- Sandi Metz, [The Wrong Abstraction](https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction)
  (2016) — "duplication is far cheaper than the wrong abstraction."
- Dillon Mulroy, [TypeScript coding standards draft](https://gist.github.com/dmmulroy/9c80f1f499b031aa0b6525b5d9ae25f0)
  — a kindred charter; the defect/failure split, adapter reuse audit, and
  idempotency checklist here trace to it.
- John Ousterhout, [*A Philosophy of Software Design*](https://web.stanford.edu/~ouster/cgi-bin/book.php)
  (2018) — deep modules and the pass-through smell.
- Vaughn Vernon, [Effective Aggregate Design](https://www.dddcommunity.org/library/vernon_2011/)
  (2011) — consistency boundaries, three free essays.
- Scott Wlaschin, [Railway Oriented Programming](https://fsharpforfunandprofit.com/rop/)
  and [Designing with types: Making state explicit](https://fsharpforfunandprofit.com/posts/designing-with-types-representing-states/)
  — errors as values; states and transitions as types.
- Greg Young, [CQRS Documents](https://cqrs.files.wordpress.com/2010/11/cqrs_documents.pdf)
  (2010) — command/query separation.
