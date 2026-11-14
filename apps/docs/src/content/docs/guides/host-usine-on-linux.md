---
title: Host usine on a Linux server
description: Run an instance on any Linux server with systemd, HTTPS, managed upgrades, and backups.
---

Run an always-on instance on a VPS or another Linux machine. This setup uses one instance per server, a global npm installation owned by the `usine` user, and systemd to start it at boot.

## Prerequisites

A Linux machine with systemd and cgroup v2, SSH access, administrator privileges, and persistent storage. Install Node.js 22.22 or later and npm system-wide, with `node` and `npm` on `/usr/local/bin` or `/usr/bin`. Install Git, Bash, curl, `timeout`, `flock`, and polkit; on Debian or Ubuntu, the last tools come from `coreutils`, `util-linux`, and `polkitd`.

To run the [supervisor](/reference/configuration/settings/#supervisor), install rootless Podman, or Docker, for the `usine` user: each supervisor turn runs in a read-only container on this server.

You also need a GitHub account that can create and install a GitHub App. For HTTPS, use a domain with a reverse proxy or a Tailscale tailnet with MagicDNS and HTTPS enabled. Keep port 7331 reachable only through loopback.

## Procedure

1. As an administrator, create the service user and instance folder:

   ```sh
   sudo useradd --create-home --shell /bin/bash usine
   sudo usermod --append --groups systemd-journal usine
   sudo install -d -o usine -g usine -m 0700 /home/usine/factory
   sudo -iu usine
   ```

   In this `usine` login shell, install the package without root access:

   ```sh
   npm config set prefix /home/usine/.local
   npm install --global @usine/server
   /home/usine/.local/bin/usine --version
   exit
   ```

2. As an administrator, create `/etc/systemd/system/usine.service`:

   ```ini
   [Unit]
   Description=usine orchestrator
   Wants=network-online.target
   After=network-online.target
   ConditionPathIsDirectory=/home/usine/factory

   [Service]
   Type=exec
   User=usine
   Group=usine
   WorkingDirectory=/home/usine/factory
   Environment=PATH=/home/usine/.local/bin:/usr/local/bin:/usr/bin:/bin
   ExecStart=/home/usine/.local/bin/usine up
   KillMode=mixed
   KillSignal=SIGTERM
   TimeoutStopSec=1h
   SuccessExitStatus=130
   Restart=on-failure
   RestartSec=10s
   NoNewPrivileges=yes

   [Install]
   WantedBy=multi-user.target
   ```

   Keep `usine up` in the foreground so systemd manages its main process. `KillMode=mixed` lets the orchestrator drain attempts before systemd terminates remaining processes. The server reads the instance's `.env` itself; store service credentials there with mode `0600` rather than using `EnvironmentFile=`.

3. Create `/etc/systemd/system/usine-upgrade.service` for the independent upgrade helper:

   ```ini
   [Unit]
   Description=usine package upgrade and rollback
   After=network-online.target

   [Service]
   Type=exec
   User=usine
   Group=usine
   WorkingDirectory=/home/usine/factory
   Environment=PATH=/home/usine/.local/bin:/usr/local/bin:/usr/bin:/bin
   ExecStart=/bin/bash /home/usine/factory/.usine/upgrade/run.sh
   TimeoutStartSec=infinity
   NoNewPrivileges=yes
   ```

   The orchestrator writes `run.sh` when an upgrade starts. Leave this service disabled at boot; the orchestrator starts it on demand so package replacement and rollback can continue while `usine.service` stops.

4. Create `/etc/polkit-1/rules.d/50-usine.rules` to let the service user manage only these units:

   ```js
   polkit.addRule(function (action, subject) {
     if (
       action.id === "org.freedesktop.systemd1.manage-units" &&
       ["usine.service", "usine-upgrade.service"].indexOf(action.lookup("unit")) >= 0 &&
       subject.user === "usine" &&
       ["start", "stop", "restart"].indexOf(action.lookup("verb")) >= 0
     ) {
       return polkit.Result.YES;
     }
   });
   ```

   Then load the units and start the orchestrator:

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now usine.service
   sudo journalctl -u usine.service -n 80
   ```

5. From your own machine, forward the loopback listener over SSH:

   ```sh
   ssh -N -L 7331:127.0.0.1:7331 your-user@server.example.com
   ```

   Replace `server.example.com` with your host and use your configured SSH account. In a separate SSH session, generate a sign-in link as the service user:

   ```sh
   sudo -iu usine
   cd /home/usine/factory
   /home/usine/.local/bin/usine sign-in-link
   ```

   Open the printed link on your own machine. Complete GitHub App creation, installation, and first-admin sign-in, then select **Open usine**. [Open the web UI](/guides/open-the-web-ui/) explains later connections.

6. Configure [remote workers](/guides/workers/) and, for agents with `coordinator: session`, supply the parent credential as the `usine` user. If using local workers, install and authenticate their harnesses as that user and ensure the service's `PATH` includes them. [The quickstart](/get-started/quickstart/) demonstrates authentication for each harness.
7. [Expose the instance over HTTPS](/guides/expose-an-instance/) using Caddy, another reverse proxy, or Tailscale Serve. Set `USINE_ORIGIN` in `/home/usine/factory/.env` to the HTTPS address, update the GitHub App callback, and restart the service. Complete first-member enrollment before sharing the address.
8. [Back up instance state](/guides/back-up-instance-state/) to protected storage on another machine, including both databases and the credential files. Keep a recoverable backup before [upgrading](/guides/upgrade-an-instance/). Run `/home/usine/.local/bin/usine upgrade --check` from the instance folder as `usine`; **Configuration > Settings** controls proposed or automatic upgrades. The helper backs up both stores before replacing the package and restores the previous package and stores if installation or readiness fails.

## Check the result

`systemctl is-enabled usine.service` prints `enabled`, and `systemctl is-active usine.service` prints `active`. From `/home/usine/factory` as `usine`, `/home/usine/.local/bin/usine status` reports `usine.service` as managed with systemctl. Check readiness on the server:

```sh
curl --fail http://127.0.0.1:7331/api/ready
```

After startup recovery, the response is `{"ok":true}`. The HTTPS UI requires sign-in, and an anonymous request to `/api/auth/session` returns 401. Inspect `journalctl -u usine.service` for startup errors and `journalctl -u usine-upgrade.service` for upgrade outcomes. Verify that your backup contains every database file reported by `usine backup`, and use [restore instance state](/guides/restore-instance-state/) to check recovery on a separate instance folder.

For a server in a Hetzner gateway's private network, use the [advanced Hetzner setup](/guides/run-the-orchestrator-on-a-server/).
