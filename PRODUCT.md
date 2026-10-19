# Product

<!-- impeccable:product-schema 1 -->

Shared by `apps/web` (the operator UI) and `apps/docs` (docs.usine.dev). The domain glossary is `CONTEXT.md`; decisions and their reasons are in `docs/adr/`.

## Platform

web

## Users

The primary user is a single operator who runs their own factory. Today that is the maintainer, running the dogfood instance against `basaltbytes/usine`. Outside developers who install usine with `pnpm create usine` and run it against their own repositories are the next audience; none exist yet.

The operator writes Loops and Agents, starts `usine up`, and spends most of the time away. They come back to the web UI to see what agents are working on, approve or retry Runs, steer or pause a running Attempt, read transcripts, and change configuration. Away from the UI, they unblock Runs from GitHub on a phone, by reacting to or replying to the App's Ask comments.

Docs readers are operators setting up a factory, writing Loops and Agents, and adding Workers, plus contributors reading the architecture pages and the API reference.

## Product Purpose

usine runs coding agents on the GitHub issues and pull requests of the repositories the operator registers. A Loop decides which Items open a Run, whether the operator approves it first, and which Agent does the work; the Agent works in a checkout on a Worker and usually ends with a pull request. The engine has no built-in Loop.

Success means the operator hands issue-to-PR work to agents and spends attention only where a Run needs them: every approval, failure, question, and exhausted budget reaches Needs you or a GitHub Ask, and the reason a Run did or did not act can be read from its Event, Attempts, and transcript.

## Positioning

- **Loops are the operator's files in git.** Every Loop and Agent is a Markdown file in the operator's instance repo. The UI reads and writes those files; nothing about the factory's behaviour lives only in a database.
- **Agent-agnostic.** One orchestrator runs Claude Code, Codex, and Pi children under a Pi parent, using the operator's own harness logins and accounts.
- **Self-hosted and operator-owned.** The orchestrator runs on the operator's machine; Attempts run on the local Worker, exe.dev VMs, or SSH Workers behind the operator's Gateway. Each instance pins its engine version in its own `package.json`. MIT licensed.

## Operating Context

- **Instance repo:** `usine.yaml` (registry, Workers, lanes, settings), `loops/`, `agents/`, and a gitignored `.usine/` holding runtime state and secrets.
- **Process:** `usine up` is a foreground CLI in the instance folder. It prints the local UI address; keeping it alive (tmux, launchd, systemd) is the operator's business.
- **GitHub:** a GitHub App per instance supplies the factory's identity. Polling is the source of truth and webhooks are hints. Label swaps on Items are the usual handoff between Loops.
- **Web UI:** Projects home with Needs you, a Board per Project whose label-backed lanes accept drag-and-drop moves that write labels to GitHub, a short Run drawer with the outcome and the actions that apply, a Run page with an outline of the Task, Event, and Attempts beside a reader of the conversation, and a Configuration section for Loop pauses and configuration reloads.
- **Away:** Asks are @mention comments on the Run's Item, answered by a 👍/👎 reaction or a reply. Managed repos can be public, so Asks never carry error detail, transcript excerpts, or cost figures.
- **Docs:** Astro Starlight site deployed to docs.usine.dev on every push to `main`; guides, architecture pages dated to the commit they describe, and a generated API reference.

## Capabilities and Constraints

- Terminology follows `CONTEXT.md`: Project, Board, Lane, Task, Item, Loop, Agent, Run, Attempt, Event, Worker, Needs you. UI copy and docs use these terms and avoid the listed alternatives.
- Interventions: Approve, Retry, Edit and retry, Cancel Run, Pause session, message a parent or child, Hold and Release child, Mark resolved, Mark answered, Reset cycle budget, Pause a Loop.
- The Run drawer links the pull request a Run produced; there is no reconstructed diff view.
- Proposed and state-only lanes are read-only. Moves need lanes authored in `repos[].lanes`; usine never deletes a label.
- No time or token ceilings apply unless the operator sets them. A failed or canceled Attempt keeps its work on a salvage branch or a retained worktree.
- Distribution is npm only: `pnpm create usine` and `usine up`. Packages are 0.x and their APIs change without notice.
- Undecided: when outside operators become a supported audience, and what the first-run onboarding UI from ADR 0019 looks like once built.

## Brand Commitments

- The name is `usine`, always lowercase. Domains: usine.dev and docs.usine.dev. Published by Basaltbytes.
- Voice: plain sentences that say what the product does. No taglines, slogans, or marketing cadence, in the UI and in the docs.
- The web UI follows the category standard at the craft level of Linear, the Vercel dashboard, and Raycast. Convention comes first; usine's own character stays in a few precise details.
- Factory references come from factory floor plans (bays, stations, the flow of work between them) and appear only where they carry information. No industrial ornament such as hazard stripes.
- There is no logo or wordmark asset yet.

## Evidence on Hand

- The dogfood instance runs usine on its own repository; the docs home quotes its real `loops/start-dev.md`.
- Guides in `apps/docs/src/content/docs/guides/` cover running a factory, writing a Loop and an Agent, review-fix Loops, operating Runs, and adding a Worker.
- Absent and not to be fabricated: outside users, testimonials, customer logos, usage numbers, benchmarks, pricing, and any hosted offering.

## Product Principles

1. The work is the spine. Screens are organised around Projects, Tasks, and Runs in the operator's vocabulary; Loops, Agents, and Workers are configuration.
2. Attention goes only where a Run needs it. Needs you and Asks surface every blocked Run; nothing requires checking each Project to find one.
3. Every outcome is explainable. A skipped, failed, or waiting Run shows why, with the typed reason and the data that led to it.
4. The operator's files are the truth. The UI round-trips through the instance repo and never invents its own configuration.
5. Never destroy work. Guards salvage unfinished Attempts, and destructive actions ask for confirmation.
