---
title: Pause a worker
description: Stop new attempts on a worker while its running attempts finish.
---

Pause a worker to keep new attempts off it, for example before maintenance, or to send attempts to another worker. A paused worker keeps its configuration, slots, and preflight.

## Prerequisites

Instance admin access and a running instance.

## Procedure

1. Open **Configuration > Workers**, select the worker, and edit it. Alternatively, run `usine config edit worker <name>`.
2. Select **Paused**, or set `paused: true`, and save. The change applies at once, without a restart or a preflight.
3. To resume the worker, clear **Paused**, or remove `paused`, and save.

To send new attempts to one worker, pause each worker listed before it in `workers`. The scheduler gives each new attempt to the first unpaused worker with a free slot.

## Check the result

The worker page shows **Paused**, the **Workers** line on **Overview** shows **Paused: takes no new attempts**, and **Needs attention** lists the worker until you resume it. Running attempts on the worker continue and finish. A run that reattaches an attempt already on the worker still takes a free slot there. Other runs wait for a slot on an unpaused worker. If every worker is paused, new runs wait until you resume one.
