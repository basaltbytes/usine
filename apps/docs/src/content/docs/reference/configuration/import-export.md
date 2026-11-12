---
title: Import and export format
description: YAML and Markdown serialization for configuration snapshots and entity editing.
---

Stored configuration is authoritative. Use `usine config export <folder>` to create a snapshot, and `usine config import <folder>` to replace stored configuration with that snapshot. The web UI and `usine config edit` save revisions directly. Editing an export does not apply it until import.

## Folder layout

| Path | Type | Default | Description |
| --- | --- | --- | --- |
| `usine.yaml` | YAML document | required | Instance settings, registry, projects, workers, labels, and role bindings. |
| `projects/<project>/loops/<loop>.md` | Markdown with YAML frontmatter | no loops | One loop in the named project. |
| `agents/<agent>.md` | Markdown with YAML frontmatter | empty directory | One agent's brain spec and persona. |

For example:

```text
config-export/
  usine.yaml
  agents/
    developer.md
  projects/
    widgets/
      loops/
        start-dev.md
```

Agent and loop names are lowercase letters and digits separated by single hyphens. The loop identity is `<project>/<loop>`. The `agents/` directory must exist; a project without loops can omit its loops directory.

Imports validate the complete folder and save one revision. Missing entities are removed. Keep all entities from a fresh export when adding one. Invalid YAML, unknown or duplicate keys, schema failures, invalid expressions, and unresolved references reject the whole import. An unchanged import saves no revision. New loops start paused; the initial bootstrap import preserves pause state.

Exports replace configuration files and remove stale Markdown files in their agent and loop directories. They apply defaults and do not preserve comments. They exclude credentials, revision history, and loop pause state; use [instance backups](/guides/back-up-instance-state/) for recovery.

## Settings and collections

The top-level YAML document uses snake_case keys. Each collection entry has the fields in its entity reference.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | `2` | required | Project configuration format version. |
| `settings` | [settings](/reference/configuration/settings/) | `{}` | Polling, attempt limits, parent defaults, and upgrade policy. |
| `operator` | GitHub login | omitted | Login used for initial enrollment. |
| `webhooks` | webhook settings | `{ mode: off }` | Optional source of early repository refreshes. |
| `auth` | browser origin and proxy settings | `{ origins: [], trusted_proxies: [] }` | Extra trusted browser origins and reverse proxies. |
| `tracing` | tracing settings | omitted | OTLP span export destination. |
| `repos` | list of registry entries | required | Managed repositories and selector tags. |
| `projects` | list of projects | `[]` | Project membership and lanes. |
| `workers` | non-empty list of workers | one local worker | Ordered worker records used for scheduling. |
| `labels` | list of label declarations | `[]` | Labels created in managed repositories. |
| `bindings` | list of role bindings | `[]` | Member roles on the instance or a project. |

The smallest document is `version: 2` with `repos: []`. A complete example with one development loop uses:

```yaml title="usine.yaml"
version: 2
settings:
  poll_interval: 60
  max_children: 4
repos:
  - name: acme/widgets
    tags: [web]
projects:
  - id: widgets
    name: Widgets
    repositories: [acme/widgets]
    lanes:
      - name: Ready
        sources: [{ label: ready-for-agent }]
      - name: Review
        sources: [{ label: ready-for-review }]
workers:
  - name: local
    kind: local
    max_concurrent_attempts: 1
labels:
  - name: ready-for-agent
    color: "0e8a16"
  - name: ready-for-review
webhooks:
  mode: off
```

[Settings](/reference/configuration/settings/), [projects and registry](/reference/configuration/projects/), [workers](/reference/configuration/workers/), and [access](/reference/access/) list field types and defaults. Quote label colors. A project references registered repositories, and a repository belongs to at most one project.

## Loop Markdown

A loop file starts with `---`, YAML frontmatter, and a closing `---`. Its non-blank body is the task template. LF and CRLF line endings are accepted. The file name supplies the loop name; its directory supplies the project. The [loop reference](/reference/configuration/loops/) lists the frontmatter fields by entity: trigger, selector, approval, cycle budget, permissions, priority, and CI policy.

```markdown title="projects/widgets/loops/start-dev.md"
---
trigger:
  on: issue
  if: >-
    item.state == "OPEN" &&
    item.labels.nodes.exists(label, label.name == "ready-for-agent")
approval: required
agent: developer
step: implement
max_cycles: 3
permissions: write
---
Complete issue {{ item.number }}: {{ item.title }}.
Remove ready-for-agent before editing. Open a pull request that closes the issue.
Run the repository checks and push. Do not merge.
```

A scheduled loop uses the same format:

```markdown title="projects/widgets/loops/weekly-dependencies.md"
---
trigger:
  on: schedule
  cron: "0 6 * * 1"
  tz: Europe/Paris
  if: "true"
agent: developer
---
Check {{ repo.name }} for outdated dependencies at {{ item.tick.scheduledAtLocal }}.
Open one pull request with passing checks. Do not merge.
```

Quote cron expressions and CEL containing YAML punctuation. A loop must reference an existing agent. Selectors must reference registered repositories and tags and can only narrow project membership. Undeclared labels in conditions, lanes, or `outcome_labels` produce warnings. A schedule loop can't set `outcome_labels`.

## Agent Markdown

An agent file uses the same frontmatter delimiters. Its non-blank body is the persona. The file name supplies the agent name. See [Agents](/reference/configuration/agents/) for model selection, effort values, and harness requirements.

```markdown title="agents/developer.md"
---
harness: codex
model: gpt-6-astra
effort: medium
---
Complete one repository task at a time. Follow the repository instructions.
Run the required checks, push the branch, and record blockers on the item.
Do not merge pull requests.
```

## Entity editing

`usine config edit` opens one entity, without an enclosing collection. A worker edit contains one worker object; a project edit contains one project object. Settings edits include `version`, `settings`, `operator`, `webhooks`, `auth`, and `tracing`. Loop and agent edits use the Markdown formats above. Names remain in the entity key.

```sh
usine config export ./config-export
usine config import ./config-export --message "Apply reviewed configuration"
EDITOR=vi usine config edit loop widgets/start-dev
usine config log loop widgets/start-dev
```

On the first start with empty configuration tables, the instance can import bootstrap files in this format. With no bootstrap document, startup creates empty configuration for setup. Subsequent starts use stored configuration. See [`usine config`](/reference/configuration/config/) for revision application and exit statuses.
