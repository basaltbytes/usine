---
title: Message a running agent
description: Take over a parent or child session and release it after a response.
---

Send guidance to a live session while preserving the attempt’s conversation.

## Prerequisites

A running attempt with a live session and project operator access or a higher role.

## Procedure

1. Open the run drawer or conversation. Choose **Message the parent** or **Message this child** for a live child.
2. Send the guidance. A message places a hold, so an idle session waits for you before returning its result. A working session can queue the message until its next delivery point.
3. Read the response and delivery status. If the message says **Not delivered**, inspect whether the session is paused or has ended before sending again. Use **Pause session** if you need to interrupt the current work.
4. Select **Release parent** or **Release child** when the session can continue or return its answer.

## Check the result

The transcript includes your message and the attempt shows **Operator intervened**. Release removes the hold. Wall-clock runaway limits exclude held time; token limits still count.

A parent waiting on a delegated child reads its queued message after the child returns. A child’s delivery point depends on its harness. The API’s `Steer` action adds guidance without a hold. See the [operator API](/reference/operator-api/).

A terminal resume action is available only while the checkout and required local credential still exist. Gateway-authenticated Codex sessions have no resume action because a terminal lacks the gateway credential.
