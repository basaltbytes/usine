---
title: Ask the supervisor
description: Start a conversation with the supervisor from any page and follow its answer.
---

Ask the supervisor about runs, tasks, and the source of a project or the whole instance. A turn only reads: it can't approve, retry, move, or change anything.

## Prerequisites

- A [supervisor](/reference/configuration/settings/#supervisor) configured on an orchestrator host that can run its container.
- Project operator access or a higher role to post. Project viewers can read a project's conversations.

## Procedure

1. Select the conversation icon at the right of the page header. The conversation panel opens over the current page.
2. Choose the **Scope**: the instance, or a project you can operate on. The project of the current page is chosen first.
3. Type a question and press Enter. Shift+Enter starts a new line.
4. Follow the turn. Its text and tool calls appear while it runs, and the answer follows as Markdown. Select a tool call to see its input and result.
5. Post a follow-up in the same panel. A message posted while a turn runs is queued and runs after it.

To stop a queued or running turn, select **Cancel turn**. The events that the turn produced stay in the conversation.

## Check the result

**Conversations** in the sidebar lists the conversations you can read, newest first, with each one's scope, who started it, and the state of its last turn. Select a row to open it in the panel. The panel's URL has a `conversation` parameter, so a reload or a shared link opens the same conversation.

A turn that the orchestrator was running when it restarted shows **Failed** with **The orchestrator restarted during the turn**. Post the question again. If the panel says **Supervisor not set up**, the reason names what the host lacks, such as a container runtime. With read access only, the panel shows the conversation without a composer. See the [operator API](/reference/operator-api/#conversations).
