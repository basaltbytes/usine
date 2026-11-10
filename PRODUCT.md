# Product

<!-- impeccable:product-schema 1 -->

Applies to `apps/web` (the operator UI) and `apps/docs` (docs.usine.dev). Glossary: `CONTEXT.md`. Decisions and reasons: `docs/adr/`.

## Platform

web

## Users

The primary user is one operator running their own factory: today the maintainer, dogfooding on `basaltbytes/usine`. Next: outside developers installing with `pnpm create usine`; none exist yet.

The operator writes loops and agents, starts `usine up`, and is mostly away. In the UI, they check on agents, approve or retry runs, steer or pause attempts, read transcripts, and change configuration. On a phone, they answer GitHub asks to unblock runs.

Docs readers: operators setting up a factory, and contributors reading architecture pages and the API reference.

## Product Purpose

usine runs coding agents on the issues and pull requests of registered repos. A loop picks which items open a run, whether the run needs approval, and which agent works on it, in a checkout on a worker, usually ending with a pull request. The engine has no built-in loop.

Success: the operator hands off issue-to-PR work and looks only where a run needs it. Every approval, failure, question, and exhausted budget appears in Needs attention or a GitHub ask. A run's event, attempts, and transcript show why it acted or didn't.

## Positioning

- **Loops are the operator's.** The engine has no built-in loop. Loops and agents are stored configuration with a revision history, edited in the UI or the CLI, and exported to or imported from Markdown files.
- **Agent-agnostic.** One orchestrator runs Claude Code, Codex, and Pi children under a Pi parent, with the operator's harness logins.
- **Self-hosted.** The orchestrator runs on the operator's machine; attempts run on the local worker, exe.dev VMs, or SSH workers behind a gateway. Each instance pins its engine version in `package.json`. Licensed under the GNU AGPL-3.0.

## Operating Context

- **Instance folder:** `.usine/` holds the configuration database, runtime state, and secrets. `usine.yaml`, `agents/`, and `projects/<project>/loops/` are bootstrap, import, and export files.
- **Process:** `usine up` runs in the foreground in the instance folder and prints the UI address; the operator keeps it alive with tmux, launchd, or systemd.
- **GitHub:** a GitHub App per instance is the factory's identity. Polling is the truth; webhooks are hints. Loops usually hand off by swapping item labels.
- **Web UI:** an overview at `/` (Needs attention, running attempts, stalled items with reasons, recent runs, worker slots); a board per project, where dragging a card to a label-backed lane writes labels; a run drawer with the outcome and actions; a run page with the task, event, and attempts beside the conversation; and a Configuration section showing the parsed instance, with loop pauses and reloads.
- **Away:** asks are @mention comments on the run's item, answered by a 👍 or 👎 reaction or a reply. Managed repos can be public, so asks never contain error details, transcript excerpts, or costs.
- **Docs:** Astro Starlight at docs.usine.dev, deployed on every push to `main`: guides, architecture pages dated to a commit, and a generated API reference.

## Capabilities and Constraints

- Terms follow `CONTEXT.md`, plus Needs attention. UI copy follows the Voice section of `apps/web/DESIGN.md`; docs use plain language.
- Interventions: Approve, Retry, Edit and retry, Cancel run, Pause session, message a parent or child, Hold and Release child, Mark resolved, Mark answered, Reset cycle budget, pause a loop.
- The run drawer links the run's pull request; there's no diff view.
- Proposed and state-only lanes are read-only. Moves need lanes in `repos[].lanes`. usine never deletes a label.
- No time or token limits apply unless set. A failed or canceled attempt keeps its work on a salvage branch or in a retained worktree.
- Distribution is npm only: a global `@usine/server` install or `npm create usine`, then `usine up`. usine is alpha; packages are 0.x and APIs change without notice.
- Undecided: when outside operators get support, and ADR 0019's first-run onboarding UI.

## Brand Commitments

- The name is `usine`, always lowercase. Domains: usine.dev, docs.usine.dev. Published by Basaltbytes.
- Voice: plain sentences that say what the product does. No taglines, slogans, or marketing cadence.
- The web UI meets the category standard of Linear, the Vercel dashboard, and Raycast; usine's character shows only in a few precise details.
- Factory references (bays, stations, the flow of work) come from floor plans and appear only where they inform. No industrial ornament such as hazard stripes.
- The logo is the shaded U of cells in `apps/docs/src/assets/`. No wordmark exists.

## Evidence on Hand

- The dogfood instance runs usine on its own repo; the docs home page quotes its real `loops/start-dev.md`.
- Guides in `apps/docs/src/content/docs/guides/` cover running a factory, loops, agents, review-fix loops, operating runs, and workers.
- Never fabricate (none exist): outside users, testimonials, customer logos, usage numbers, benchmarks, pricing, a hosted offering.

## Product Principles

1. Organize around the work: projects, tasks, and runs, in the operator's vocabulary. Loops, agents, and workers are configuration.
2. Show attention only where a run needs it. Needs attention and asks list every blocked run.
3. Explain every outcome. A skipped, failed, or waiting run shows its typed reason and the data behind it.
4. Stored configuration is the truth: every change is a revision, and the UI never invents configuration.
5. Never destroy work. Guards salvage unfinished attempts; destructive actions ask for confirmation.
