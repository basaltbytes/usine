---
title: Revert a configuration revision
description: Restore saved configuration values with a new revision.
---

Restore all entities changed by a selected revision.

## Prerequisites

A running instance and edit access to every affected entity.

## Procedure

1. Open **Configuration > History**. To list one entity's revisions, select **Filter** and choose the entity, or select the history link under the entity's name on its page.
2. Find the revision and inspect the before-and-after diff for every affected entity. The four latest revisions are open; select another revision to open it.
3. Select **Revert**, add a message if useful, and confirm. If a later change conflicts, inspect the latest values and edit them directly instead.

## Check the result

A new revision restores the selected revision’s before values. History retains both revisions. Runtime validation and preflight apply to the restored configuration.
