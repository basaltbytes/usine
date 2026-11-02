---
title: Export a run
description: Save a run and its transcript as JSON.
---

Save evidence for one run without starting execution.

## Prerequisites

Access to the instance folder, a known run ID from its drawer URL, and a new output path.

## Procedure

1. Open the run and copy its ID from `?run=<id>` in the URL.
2. From the instance folder, export it:

   ```sh
   usine export-run <run-id> --output /evidence/run.json
   ```

3. Inspect the JSON for repository content, credentials in tool output, and other private information before sharing it.

## Check the result

The command creates a private JSON file containing the run snapshot and transcript. It refuses an existing output path or unknown run. The operation reads the runtime store without starting the orchestrator.
