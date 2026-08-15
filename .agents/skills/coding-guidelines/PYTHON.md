# Always-Valid Domain — Python (pydantic v2 strict)

Python dataclasses do NOT validate annotations at runtime: `Period(start="2026-01-01",
end="2026-02-01")` constructs happily, and `Period(datetime_a, datetime_b)` passes even
an `isinstance` guard because `datetime` subclasses `date`. pyright/mypy only cover the
files they check — host call-sites, ORM layers, and scripts are usually outside.

## Value objects: strict + frozen

```python
from pydantic import BaseModel, ConfigDict, model_validator


class Period(BaseModel):
    """A valid, non-empty, half-open civil date range — not 'two dates'."""

    model_config = ConfigDict(strict=True, frozen=True)

    start: date
    end: date

    @model_validator(mode="after")
    def _non_empty(self) -> "Period":
        if self.end <= self.start:
            raise ValueError(f"empty period: [{self.start}, {self.end})")
        return self
```

`strict=True` = shape (no coercion: `"2026-01-01"` is rejected, not parsed);
`model_validator(mode="after")` = semantic invariants; `frozen=True` = a proof stays a
proof.

When call-site churn matters (positional init, `dataclasses.fields`), use
`@pydantic.dataclasses.dataclass(config=ConfigDict(strict=True), frozen=True)` with
`__post_init__` for invariants — same guarantees, dataclass ergonomics.

## Scalars: nominal wrappers, not aliases

`EmployeeId = str` and `Annotated[str, StringConstraints(...)]` are structural — any
string still passes. Python has no branded types; the honest newtype is nominal:

```python
class EmployeeId(str):
    def __new__(cls, value: str) -> "EmployeeId":
        if not value.strip():
            raise ValueError("empty employee id")
        return super().__new__(cls, value)
```

Reserve wrappers for values whose confusion would be a real bug (ids, money,
quantities); don't wrap every string.

## Pin the subclass traps with tests

stdlib subtyping lets wrong values satisfy `isinstance`: `datetime` is-a `date`,
`bool` is-an `int`. pydantic strict validates by declared type and rejects these — but
pin it with explicit rejection tests instead of trusting version behavior:

```python
def test_period_rejects_datetime() -> None:
    with pytest.raises(ValidationError):
        Period(start=datetime(2026, 1, 1, 8), end=datetime(2026, 1, 2))
```

If Hypothesis is available, add rejection properties: generated invalid shapes must
raise at construction, never construct.

## Translate errors at the package edge

`ValidationError` is your library's internal detail. At the public boundary, catch it
and raise the boundary's own taxonomy (`MalformedRuleError`, HTTP 422, …) — callers
should never depend on pydantic's error format.

## Zero-dependency fallback

When a package must stay stdlib-only, hand-write the same contract in `__post_init__`:
exact-type checks (`type(v) is date` — deliberately dodging the subclass trap), then
invariants. Same principle, more maintenance; prefer pydantic when a runtime dep is
acceptable.
