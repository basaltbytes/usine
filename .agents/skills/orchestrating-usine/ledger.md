# Ledger and report

The ledger is `.scratchpad/orchestrating-usine/ledger.md`. It is the only memory that survives a context reset, a handoff, or a session the human never read. The report at the end of each pass is a copy of the ledger's open sections plus what changed, so a human who reads one message has everything.

## Rules

- An item stays until the human acts on it or dismisses it. A dismissed item moves to Done with `dismissed`.
- A decision is the question itself, with two or three lines of context and the options you see. Never "see #123": the human should answer without opening anything.
- An action is one command the human runs, or one thing only they can do, with its script in `actions/`. State what it changes and how to check it worked. In Claude Code the human runs a command from the prompt with the `!` prefix, so give it in that form.
- Done is dated, newest first, one line per outcome. Keep the last seven days.
- Watchlist is what is in flight and its next step; it replaces re-reading the overview.
- Write the ledger before the report, every pass, even when nothing changed.

## Ledger

```markdown
# usine ledger

Instance: <USINE_URL>, version <x>. Updated <UTC time>.

## Decisions for you

- [ ] **<question in one line>** Context: <two or three lines>. Options: <a>, <b>. Blocking: <what waits>.

## Actions for you

- [ ] **<what it does>**: `! bash .scratchpad/orchestrating-usine/actions/<slug>.sh` Check: <how to see it worked>.

## Watchlist

| Item | State | Next |
| --- | --- | --- |
| PR #<n> <title> | review-passed, finisher running | read diff, merge |

## Done

- <UTC date time> merged #<n> (closes #<m>); default-branch workflows green.
- <UTC date time> upgraded to <version>; backup at <path>.
```

## Report

Lead with the state in one line, then the three inventories in this order, copied from the ledger: Decisions for you, Actions for you, Done since the last report. Leave out an empty section's heading except Decisions, which says `none` when empty so the human knows nothing waits. Watchlist goes last, only when it changed. No prose between sections. No question that the ledger does not also hold.
