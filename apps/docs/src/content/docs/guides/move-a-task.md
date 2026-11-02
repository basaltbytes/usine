---
title: Move a task on the board
description: Route a task by changing its current item’s GitHub labels.
---

Move a task to a configured label lane and let its matching loop start.

## Prerequisites

A project with authored label lanes and project operator access or a higher role.

## Procedure

1. Open the project’s **Board** and find the task. Expand **Unmapped** if it has no matching lane.
2. Read the card’s repository and current item. For linked issues and pull requests, the current item determines which GitHub item receives the labels.
3. Drag the card to a label lane, or select **Move to** in its menu. Read-only state lanes cannot accept moves that change GitHub state.

## Check the result

The item gains the destination lane’s labels and loses other authored lanes’ labels. Its matching active loop opens a run after polling. Moving a card does not close an issue or merge a pull request.

An arrow between lanes lists matching loops and indicates pause, queue, running, or approval state. [Projects and registry](/reference/configuration/projects/#lane) describes lane placement.
