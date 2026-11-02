---
title: Revert a configuration revision
description: Restore saved configuration values with a new revision.
---

Restore all entities changed by a selected revision.

## Prerequisites

A running instance and edit access to every affected entity.

## Procedure

1. Open **Configuration > History**, or **History** on an entity.
2. Select the revision and inspect the before-and-after diff for every affected entity.
3. Select **Revert**, add a message if useful, and confirm. If a later change conflicts, inspect the latest values and edit them directly instead.

## Check the result

A new revision restores the selected revision’s before values. History retains both revisions. Runtime validation and preflight apply to the restored configuration.
