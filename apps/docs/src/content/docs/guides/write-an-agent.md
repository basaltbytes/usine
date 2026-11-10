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

## Compare models

The agent page's **Models** section compares the models this agent ran with on merged tasks in the selected window: 7 days, 30 days, or all stored runs. Each task counts for the harness and model of the agent's first attempt on it. A task is mixed if a later attempt by the agent used another harness or model; it still counts for the first model. Reasoning effort does not split the tasks.

For each model, the section shows the tasks merged, the tasks that passed the first review, the median review rounds, and the median tokens, price, and time from first attempt to merge per task, with every loop of the task included. A figure based on fewer tasks than the model's total says how many tasks it covers. The configured model is marked **Configured**. The section names the model whose tasks most often passed the first review only when at least two models have 5 or more merged tasks each. To switch models, edit the agent.
