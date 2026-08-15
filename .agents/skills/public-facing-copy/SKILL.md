---
name: public-facing-copy
description: Keeps public-facing project text user-oriented and free of private discussion, thought process, and roadmap leakage. Use when editing README files, docs, PR titles or bodies, changelogs, release notes, package metadata, website copy, marketplace listings, or any text intended for external readers.
---

# Public-Facing Copy

## Rule

Write public artifacts for the reader who encounters the project cold. Do not expose the private conversation, the agent's reasoning trail, discarded alternatives, emotional context, or implementation diary.

Use the google dev docs style. More dead prose. No aphorisms, no flourishes. Simple.

## Use For

- README and documentation edits
- PR titles and PR bodies
- changelogs and release notes
- package metadata and marketplace copy
- website or landing-page text
- issue summaries that external contributors may read

## Workflow

1. Identify the audience and artifact.
   - Public user: explain what they can do.
   - Maintainer: summarize the end state and operational impact.
   - Reviewer: state what changed and why it matters to review.

2. Translate private context into public value.
   - Private: "we discussed matching another project's installer UX."
   - Public: "Install globally with npm, then pin the project-local version."
   - Private: "we do not have every installer channel yet."
   - Public: omit it unless the user explicitly asks for an installation matrix.

3. Prefer affirmative, current-state wording.
   - Say what is supported, required, shipped, fixed, or changed.
   - Avoid cataloging what is absent, postponed, rejected, or considered.
   - Mention limitations only when they prevent a likely user mistake.

4. For PR bodies, summarize the final diff.
   - Do not include a chronological work log.
   - Do not mention back-and-forth, private rationale, failed attempts, or prompt history.
   - Include concise bullets for product/runtime impact and tests when useful.

5. Before finalizing, scan for leakage.
   - Remove phrases like "not yet", "we discussed", "we decided", "I changed", "I found", "currently not", "future", "roadmap", "fallback", "internal", "private", "thought process".
   - Keep compatibility notes concrete and user-facing, for example "Windows users should run inside WSL2."
   - If a negative statement remains, verify it protects the reader from a real mistake.

## Examples

Bad README copy:

```md
We considered several installer channels, but only the npm path is ready right now.
```

Better README copy:

```md
Install the CLI with npm:

npm install -g @basaltbytes/odoo-agentic-dev
```

Bad PR summary:

```md
After several attempts, I first wrote the docs one way, then corrected them after feedback.
```

Better PR summary:

```md
Adds a packed npm install smoke test and documents the npm-based install flow.
```

## Final Check

- The copy serves the external reader, not the private conversation.
- The text describes shipped behavior, not internal reasoning.
- Necessary limitations are phrased as practical guidance.
- PR summaries describe the final state of the branch against the target branch.
