---
title: Write a schedule loop
description: Start a loop at a recurring time in a selected time zone.
---

Create a weekly dependency check for the repositories in a project.

## Prerequisites

A running instance, a project with managed repositories, an agent, and project maintainer or instance admin access.

## Procedure

1. Open **Configuration > Loops > New**, select the project, and enter `weekly-dependencies`.
2. Select the `schedule` stream. Set cron to `0 6 * * 1`, time zone to `Europe/Paris`, and condition to `true`.
3. Choose the agent and enter the task:

   ```text
   Check {{ repo.name }} for outdated dependencies as of {{ item.tick.scheduledAtLocal }}.
   Open one pull request with the updates and passing repository checks. Do not merge.
   ```

4. Use selectors if only some project repositories need the check. Save the loop, review its definition, and select **Resume**.

## Check the result

At the next Monday 06:00 tick in Europe/Paris, one run opens per selected repository. Find schedule runs under **Runs without a card** on the project board. After downtime, only the latest missed tick fires.

[Trigger fields](/reference/configuration/loops/#trigger) describes cron and time-zone settings. Schedule loops do not use cycle budgets.
