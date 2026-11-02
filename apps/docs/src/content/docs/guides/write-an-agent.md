---
title: Write an agent
description: Choose a harness, model, reasoning effort, and standing instructions.
---

Create an agent that loops can use for repository work.

## Prerequisites

Instance admin access, workers with the intended child harness and credentials, and a usable Pi parent credential for the Unix user running the orchestrator. See [harness requirements](/reference/configuration/agents/#harness-requirements).

## Procedure

1. Open **Configuration > Agents > New** and enter a kebab-case name, such as `developer`.
2. Choose a harness, its model ID, and reasoning effort. For example, choose `codex`, `gpt-6-astra`, and `medium`. Pi model IDs use `provider/model`.
3. Enter standing instructions in the persona:

   ```text
   Complete one repository task at a time. Follow the repository instructions.
   Run the required checks, keep the branch reviewable, and push before finishing.
   Record blockers on the issue or pull request. Do not merge.
   ```

4. Set parent model and effort overrides if this agent needs different values from the instance defaults. The parent runs in the orchestrator and delegates to children on workers.
5. Save the agent. Correct validation or preflight failures before assigning it to a loop.

## Check the result

The agent appears in **Configuration > Agents** and in the loop agent selector. A new run records that agent definition. Edits apply to new runs; use **Edit and retry** to apply an updated definition to a failed run.

For later CLI edits, run `EDITOR=vi usine config edit agent developer`. [Agents](/reference/configuration/agents/) explains parent selection and preflight.
