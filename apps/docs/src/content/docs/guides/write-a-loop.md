---
title: Write an issue loop
description: Create and preview a loop that starts work on labeled issues.
---

Create a loop that asks an agent to work on open issues labeled `ready-for-agent`.

## Prerequisites

A running instance, a project containing the managed repository, an existing `developer` agent, and project maintainer or instance admin access. Register `ready-for-agent` under **Configuration > Labels**.

## Procedure

1. Open **Configuration > Loops > New**. Select the project and enter `start-dev` as the loop name.
2. Choose the `issue` stream and the `developer` agent. Set approval to `required` while testing.
3. Enter this condition:

   ```cel
   item.state == "OPEN" &&
   item.labels.nodes.exists(label, label.name == "ready-for-agent") &&
   !item.closedByPullRequestsReferences.nodes.exists(pr, pr.state == "OPEN")
   ```

4. Enter a task that defines the expected output and label changes:

   ```text
   Complete issue {{ item.number }}: {{ item.title }}.
   Remove ready-for-agent before editing. Follow the repository instructions.
   Open a non-draft pull request whose body closes the issue.
   Run the required local checks and push. Do not merge the pull request.
   ```

5. Check **Preview** against stored items. Inspect the rendered task and matching repositories. An unpolled repository has no preview data; wait for a poll before testing the condition.
6. Save the loop. Review its condition, task, and agent, then select **Resume**.
7. Add `ready-for-agent` to a test issue on GitHub. Open **Overview** and approve the waiting run after inspecting its task.

## Check the result

The run appears on the project task page and starts when a worker slot is free. Its rendered task includes the issue number and title. The agent opens a pull request after its checks pass.

Edit an existing definition with `EDITOR=vi usine config edit loop widgets/start-dev`, using your project ID. [Loops](/reference/configuration/loops/) lists every field. For clock-based work, [write a schedule loop](/guides/write-a-schedule-loop/).
