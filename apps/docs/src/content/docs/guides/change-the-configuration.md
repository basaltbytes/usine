---
title: Change the configuration
description: Save an entity change as a configuration revision.
---

Change stored configuration through an entity form or the local CLI.

## Prerequisites

A running instance and the role required for the entity: instance admin for settings and shared entities, or project maintainer for loops and lanes. Local CLI changes require access to the instance folder.

## Procedure

1. Open **Configuration** and select the entity to change. Use **New** on its list to create an entity, or **Edit** on an existing entity.
2. Change the fields. Use **Edit as text** for the entity's serialized representation. Review validation errors and, for loops, **Preview**.
3. Add a revision message if useful and select **Save**. If another revision changed the entity first, inspect the diff, use **Reload text**, and reapply your draft.
4. For a local edit of an existing entity, run the matching command from the instance folder instead:

   ```sh
   EDITOR=vi usine config edit settings instance
   ```

   Save and close the editor. Use [import and export](/reference/configuration/import-export/) for a complete configuration snapshot or bulk changes.

## Check the result

Open the entity’s **History** and confirm its changed fields, actor, time, and revision message. Accepted live changes apply to new work. CLI storage success can precede runtime acceptance; check [revision application](/reference/configuration/config/#revision-application) for preflight and restart requirements.

New loops start paused. [Revert a configuration revision](/guides/revert-configuration/) to restore a saved value.
