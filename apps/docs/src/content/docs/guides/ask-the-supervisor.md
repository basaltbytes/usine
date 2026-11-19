---
title: Ask the supervisor
description: Start a conversation with the supervisor from any page, follow its answer, answer its permission requests, and see which conversations have unread activity.
---

Ask the supervisor about runs, tasks, and the source of a project or the whole instance, or ask it to act on them. A turn reads with the access of the member who posted the message. When it calls an operation that changes the factory, such as a retry or a board move, usine runs nothing and stores a permission request that a member answers, unless a standing grant covers the call. A conversation on a project asks only for operations in that project; ask for an upgrade or a worker operation in a conversation on the instance. See [Permission requests](/reference/operator-api/#permission-requests).

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

## Answer a permission request

A permission request appears in the turn at the place of the call that made it, with a peach border while it waits. It shows the operation, its target, its project or **Instance**, and its arguments; long arguments are folded under **Arguments**.

1. Read the operation and its arguments. usine runs the call with exactly these arguments.
2. Select an answer:
   - **Allow once** runs the call as you.
   - **Allow always for** the project runs the call and stores a standing grant: later calls of the same operation in that project, from any conversation, run without a request.
   - **Deny** runs nothing.

   An operation outside a project, such as an upgrade, an operation that sends text to a coding agent, such as an operator message, and a configuration write offer **Allow once** and **Deny** only. Without the access that the operation needs, the request says what answering needs and has no answers.
3. Check the outcome under the request: who answered, then **Ran** with the operation's **Result**, **Failed** with its error, or **Interrupted by a restart, outcome unknown**. A call that a standing grant covered shows **Allowed by a standing grant from** the member who created it.

When every request of the turn has an answer, a message from usine lists the outcomes, and the supervisor's next turn starts with them. A request that another member answered first returns an error and changes nothing.

## Review standing grants

Open **Configuration** > **Standing grants**. The page lists each grant in the projects you can read, with its operation, its project, the member who allowed it, when, and when a call last ran under it. **Inactive** marks a grant whose member lacks the access that the operation needs; calls of that operation wait for an answer again. To revoke a grant, select **Revoke**, then **Confirm revocation**. **Allowed calls** lists the calls that supervisor turns ran, latest first, with who allowed each, the grant that covered it, and its outcome; **Open** opens its conversation.

## Check the result

The inbox lists conversations by latest activity, newest first. Each row shows the title, the scope, who started the conversation, how long ago it last changed, the start of its last message, and the last turn's state while it is queued, running, or failed. A dot and a bold title mark a conversation with activity you haven't read: an answer, another member's message, or a failed turn. Your own messages never mark a conversation unread. Opening a conversation marks it read, and so does new activity while it is open. The conversation icon in the page header shows how many conversations are unread.

In the list, the arrow keys or J and K move between rows, and Enter opens one. Escape goes back to the list, then closes the inbox. **Conversations** in the sidebar opens the same inbox as a full page. The URL has a `conversation` parameter, so a reload or a shared link opens the same conversation.

A turn that the orchestrator was running when it restarted shows **Failed** with **The orchestrator restarted during the turn**. Post the question again. If the inbox says **Supervisor not set up**, the reason names what the host lacks, such as a container runtime. With read access only, a conversation has no message box. See the [operator API](/reference/operator-api/#conversations).
