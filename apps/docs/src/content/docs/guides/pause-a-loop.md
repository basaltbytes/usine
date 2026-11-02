---
title: Pause a loop
description: Stop new trigger runs while existing runs continue.
---

Pause a loop before changing how it selects work.

## Prerequisites

A running instance and project operator, project maintainer, or instance admin access.

## Procedure

1. Open **Configuration > Loops** and select the loop.
2. Select **Pause**. Existing runs and attempts continue; cancel them separately if required.
3. Make and review the configuration change. Select **Resume** when the trigger can start new work.

## Check the result

The loop displays its paused state until resumed, including after an orchestrator restart. Resuming an issue or pull request loop causes the next poll to scan repository items again. Unchanged item content remains deduplicated.
