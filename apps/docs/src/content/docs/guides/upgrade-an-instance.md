---
title: Upgrade an instance
description: Upgrade a managed server or a project-local package installation.
---

Install a selected usine release and verify the restarted instance.

## Prerequisites

Access to the instance machine, a recoverable backup, and either a global installation managed by systemd with the upgrade helper or an instance-local registry pin. A checkout installation must be pulled and built separately.

## Procedure

1. From the instance folder, inspect the running and available versions:

   ```sh
   usine upgrade --check
   ```

2. For a managed global server, choose **Configuration > Settings** and set upgrade channel `latest` or `next` and mode `propose`, `automatic`, or `off`. Proposed upgrades appear there. Automatic upgrades wait for admitted attempts to finish.
3. Request the upgrade:

   ```sh
   usine upgrade
   ```

   Use `usine upgrade <version>` to select a release. `--force` requests immediate restart and reattachment. Local pin upgrades refuse running attempts unless forced; global managed upgrades wait for idle by default.
4. For systemd, inspect **Settings** and `journalctl -u usine-upgrade.service -f` for the final outcome. For local pins, inspect the command output and `.usine/usine.log`.

## Check the result

`usine status` reports the selected version, and the authenticated UI loads. The managed helper verifies `/api/version` and waits up to 180 seconds for `/api/ready` after recovery. Failed managed installation or readiness restores the prior package and database backup; inspect its recorded failure before retrying.

Managed upgrades check that required packages resolve before draining. The helper backs up both stores before changing packages. Instance-local upgrades back up stores, change package pins, install dependencies, commit the pin change, and restart. A failed local installation restores manifests and lockfiles; follow the CLI’s recovery instructions if startup fails.

Keep backup files until you verify the result. [CLI upgrade reference](/reference/cli/#usine-upgrade) describes flags and installation requirements.
