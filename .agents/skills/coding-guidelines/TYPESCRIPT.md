# Always-Valid Domain — TypeScript (Zod)

TypeScript types are erased at runtime: `as X` casts, `JSON.parse`, `fetch` responses,
DB driver rows, and `process.env` all produce values the compiler trusts but nobody
checked. Zod is the runtime that makes the annotation true.

## Parse at the edge, brand the result

```ts
const Period = z
  .object({ start: z.coerce.date(), end: z.coerce.date() })
  .refine((p) => p.end > p.start, "empty period")
  .brand<"Period">();

type Period = z.infer<typeof Period>;

// Edge: raw input becomes a domain type, or the edge answers with its own vocabulary.
app.post("/plan", (req, res) => {
  const parsed = Period.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());
  return res.json(plan(parsed.data));
});

// Interior: only the branded type is accepted; a raw {start, end} does not compile.
function plan(period: Period) { ... }
```

The `.brand<>()` is the point: without it, any structurally-matching object satisfies
the type and functions can be called with unparsed data. With it, `Period.parse` is the
only door.

## Scalars: branded primitives

```ts
const EmployeeId = z.string().uuid().brand<"EmployeeId">();
type EmployeeId = z.infer<typeof EmployeeId>;
```

`function pay(to: EmployeeId, amount: Money)` cannot be called with two swapped
strings. Reserve brands for values whose confusion is a real bug.

## States: discriminated unions, not optional fields

```ts
// Smell: one type, nullable field, downstream narrowing with `!` or `?? throw`.
type Evaluation = { status: string; breachedAt?: Date };

// Always-valid: each state carries exactly its own data.
const Evaluation = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }),
  z.object({ status: z.literal("breach"), breachedAt: z.date() }),
  z.object({ status: z.literal("not_evaluable"), missing: z.array(z.string()) }),
]);
```

## Discipline

- `schema.parse(...)` / `safeParse(...)` at every edge: HTTP, DB rows, env
  (`Env.parse(process.env)` once at boot), queues, files.
- Never `as X` past an edge, never `!` in domain code — narrowing lies the runtime
  won't honor. Parse, or introduce the variant in which the value cannot be absent.
- Cross-field invariants live in the schema (`.refine`/`.superRefine`), so the parse
  is the single gate — not spread across call-sites.
- `ZodError` is edge vocabulary: translate it there (400 + issues); domain code never
  imports it.
