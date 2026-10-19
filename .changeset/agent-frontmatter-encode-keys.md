---
"@usine/config": patch
---

Agent frontmatter renames `parent_model` and `parent_effort` to `parentModel` and `parentEffort` with `Schema.encodeKeys`, as `Settings` does. Agent files parse the same as before.
