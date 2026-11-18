---
title: Ask the supervisor
description: Start a conversation with the supervisor from any page, follow its answer, and see which conversations have unread activity.
---

Ask the supervisor about runs, tasks, and the source of a project or the whole instance. A turn only reads: it can't approve, retry, move, or change anything.

## Prerequisites

- A [supervisor](/reference/configuration/settings/#supervisor) configured on an orchestrator host that can run its container.
- Project operator access or a higher role to post. Project viewers can read a project's conversations.

## Procedure

1. Select the conversation icon at the right of the page header. The supervisor inbox opens over the current page, with the conversations you can read.
2. Select **New conversation**, then choose the **Scope**: the instance, or a project you can operate on. The project of the current page is chosen first.
3. Type a question and press Enter. Shift+Enter starts a new line.
4. Follow the turn. Its text appears while it runs, and the tool calls between two texts fold into one line that says what they did and how many failed. While the turn runs, a line under the fold shows the running call. The answer follows as Markdown. Select a fold to list its calls, then select a call to see its input and result.
5. Post a follow-up in the same conversation. A message posted while a turn runs is queued and runs after it.

To stop the running turn, select **Stop**, the square button that replaces the send button while a turn runs and the message box is empty. Typing in the box brings the send button back, and Enter always sends. To cancel a queued turn, select **Cancel turn** on its row, then **Confirm cancel**. The events that a stopped turn produced stay in the conversation.

## Check the result

The inbox lists conversations by latest activity, newest first. Each row shows the title, the scope, who started the conversation, how long ago it last changed, the start of its last message, and the last turn's state while it is queued, running, or failed. A dot and a bold title mark a conversation with activity you haven't read: an answer, another member's message, or a failed turn. Your own messages never mark a conversation unread. Opening a conversation marks it read, and so does new activity while it is open. The conversation icon in the page header shows how many conversations are unread.

In the list, the arrow keys or J and K move between rows, and Enter opens one. Escape goes back to the list, then closes the inbox. **Conversations** in the sidebar opens the same inbox as a full page. The URL has a `conversation` parameter, so a reload or a shared link opens the same conversation.

A turn that the orchestrator was running when it restarted shows **Failed** with **The orchestrator restarted during the turn**. Post the question again. If the inbox says **Supervisor not set up**, the reason names what the host lacks, such as a container runtime. With read access only, a conversation has no message box. See the [operator API](/reference/operator-api/#conversations).
