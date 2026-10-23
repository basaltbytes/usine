# Config editing: forms first, raw fallback, preview before arming

In the v1 web UI, every authored surface has a form as primary editor and a raw "edit source" fallback. Both validate before committing to the default branch: forms write single fields through the YAML AST, the raw editor writes whole files, and schema or CEL errors block saves.

The loop form is one flat form over the frontmatter: a stream dropdown, `if:` as validated CEL text with live check-phase errors and autocomplete over the stream's payload slice, registry-bound selector pickers, an approval toggle, the step name, and a roster agent dropdown. A Markdown prompt pane checks `{{ }}` likewise. The form previews what `if:` matches in polled state and renders the prompt for a sample match. UI-created loops start paused, and unpausing deliberately arms them; git-committed loops start armed. Lane maps get a visual manager over the repo's live labels. Agents get harness and effort dropdowns, and a free-text model field with non-blocking, harness-aware suggestions. `usine.yaml` gets an installation-bound add-repo picker; workers and settings are plain fields.

## Considered options

- **Raw editor everywhere**: cheapest and fully general, but wastes the UI's one edge over a local editor: fields bound to live data the file can't show (repo labels, roster names, installation repos).
- **Visual condition builder for `if:`**: rebuilds ADR 0004's rejected filter-key catalog as UI, with two representations of one expression to keep in sync.
- **Curated model dropdowns**: models change faster than usine releases, so a stale list would block valid new ids.
- **All new loops paused, git included**: files-first means a committed loop is live. Requiring a UI visit per git loop breaks pure-git operation, and a cloned instance repo would boot fully paused.
- **Forms first, raw fallback, preview before arming** (chosen).

## Consequences

- Forms first justifies ADR 0004's targeted YAML-AST writer: form edits rewrite only changed fields, keeping comments and formatting. Both editors refuse invalid saves, so only out-of-band git edits get quarantined.
- `enabled:` leaves the loop schema (ADR 0004 amended): pause is database state only, per ADR 0009, resolving their contradiction. Losing the database re-arms every loop, accepted under ADR 0010's cold-start refire.
- Match and prompt previews use already-polled state, with no extra GitHub calls; an unpolled repo shows "no data yet".
- The add-repo picker lists only unregistered installation repos, so the UI can't create registry-installation drift (ADR 0011). Drift from git keeps its per-project error.
- A future form must clear the same bar: binding live data the file author can't see. Everything else stays raw-first.
- Both editors refuse a save over a file changed since loading (reload, reapply). Generated commit messages name the surface and field.
