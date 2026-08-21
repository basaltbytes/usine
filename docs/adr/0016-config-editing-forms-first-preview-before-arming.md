# Config editing: forms first, raw fallback, preview before arming

Every authored surface in the instance repo gets a structured form as its primary editor in the v1 web UI, and every file keeps a raw "edit source" escape hatch; both paths validate before committing to the default branch (surgical YAML-AST field writes from forms, whole-file writes from the raw editor, saves blocked on schema or CEL errors). The loop form is one flat form over the frontmatter — stream dropdown, `if:` as validated CEL text with live check-phase errors and autocomplete over the stream's payload slice (no visual condition builder), selector pickers bound to the registry, approval toggle, step name, agent dropdown from the roster — plus a Markdown prompt pane whose `{{ }}` runs the same checker. The form live-previews what `if:` matches against already-polled state and renders the interpolated prompt for a sample matched item; UI-created loops are born paused, and unpausing is the deliberate arming act — git-committed loops are born armed. Lane maps get a visual manager fed by the repo's live labels; agents get a form with harness/effort dropdowns and a free-text model field with non-blocking harness-aware suggestions; `usine.yaml` gets an installation-bound add-repo picker with workers and settings as plain fields.

## Considered Options

- **Raw editor as the primary surface everywhere** — cheapest and fully general, but wastes the UI's one advantage over the local editor: binding fields to live data the file can't show (repo labels, roster names, App-installation repos).
- **Visual condition builder for `if:`** — rejected: it rebuilds the per-trigger filter-key catalog ADR 0004 already rejected, as UI chrome, and leaves two representations of one expression to keep honest.
- **Curated model dropdowns on the agent form** — rejected: models churn faster than usine releases; a stale list would block valid new ids.
- **All new loops born paused, git path included** — rejected: files-first means a loop committed to the default branch is live; forcing a UI visit per git-authored loop breaks pure-git operation, and a cloned instance repo would boot fully paused.
- **Forms first, raw fallback, preview before arming** (chosen).

## Consequences

- The forms-first posture is what pays for ADR 0004's surgical YAML-AST write machinery: form edits rewrite only the changed fields, comments and formatting survive. The raw editor replaces whole files. Both refuse invalid saves, so quarantine remains the net for out-of-band git edits only — the UI never manufactures a quarantined loop.
- `enabled:` leaves the loop-file schema (ADR 0004 amended): Pause is orchestrator DB state only, per ADR 0009, resolving the standing contradiction between the two. DB loss re-arms every loop — accepted as part of ADR 0010's cold-start-refire posture.
- Match preview and prompt preview evaluate against state the trigger layer has already polled — no extra GitHub calls; a repo not yet polled previews as "no data yet".
- The add-repo picker lists only App-installation repos not yet registered, so registry⊆installation drift (ADR 0011) cannot be created from the UI; drift arriving via git keeps its per-project error.
- The bar a future form must clear is the one the chosen forms clear: it binds to live data the file author can't see from inside the file. Anything else stays raw-first.
- Stale-base protection on both editors: a save over a file changed since load is refused (reload, re-apply). Commit messages are generated, naming the surface and field touched.
