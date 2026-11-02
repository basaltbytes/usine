---
title: Change the configuration
description: Save configuration revisions in the web UI or with usine config.
---

## Change the configuration

For command-line changes, run `EDITOR=vi usine config edit settings instance`, `usine config edit worker local`, or `usine config edit loop widgets/start-dev`. To add entities or change several together, export a folder, edit it, and import it with a message. See [`usine config`](/reference/configuration/config/) for every entity kind and the fields that require a restart.

Open **Configuration** to change loops, agents, workers, repositories, labels, or settings. On a detail page, select **Edit**, change the export-format text, optionally enter a message, and select **Save**. Errors appear below the editor with their field paths. If another change was saved first, review the newer revision's diff and select **Reload text**; your draft remains below the editor for copying.

Use **New** on a list to create an entity from a template. New loops start paused; review the trigger and prompt before selecting **Resume**. **Delete** shows the entity name and affected loops or projects before confirmation. Removing a label declaration does not delete labels on GitHub.

Each detail page has **History**, with revision numbers, actors, times, and messages. Select a revision to see the before-and-after text as a diff. **Revert** creates a revision restoring every entity in the selected revision, with an optional message. A later change to an affected entity can prevent a revert. **Configuration > History** lists all revisions and links to the changed entities.

Revisions accepted by the UI apply live to new work; running attempts continue. The UI refuses a change that needs a restart or fails worker preflight. CLI writes save these revisions, but the running configuration stays unchanged until the restart or preflight succeeds. For command-line editing and bulk changes, use [`usine config edit`, `import`, `export`, and `log`](/reference/configuration/config/). Files are an import and export format; editing the original files does not change the stored configuration.
