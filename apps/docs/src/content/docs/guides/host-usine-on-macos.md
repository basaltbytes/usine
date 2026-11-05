---
title: Host usine on a Mac
description: Run an always-on orchestrator with launchd, tailnet HTTPS, and managed upgrades.
---

Run one instance as a macOS LaunchAgent owned by your login user. launchd starts it at login and restarts it after an exit. The upgrade helper runs as a second job so it can replace the package and restore backups while the orchestrator stops.

## Prerequisites

An always-on Mac, Homebrew, persistent storage, and a user account that can create and install a GitHub App. This setup uses a LaunchAgent, so the user must log in after every reboot. Configure automatic login only if appropriate for the machine; FileVault can require an unlock before login. Logging out stops the jobs. For unattended startup before login, use the [Linux hosting guide](/guides/host-usine-on-linux/).

The examples use `/Users/usine` as the home directory and `/opt/homebrew` as the Homebrew prefix. Replace both throughout with your home directory and the output of `brew --prefix`; Intel Macs commonly use `/usr/local`. Use absolute paths in plists because launchd does not expand `~` or shell variables.

## Install

1. Install Node.js and the helper's command-line tools:

   ```sh
   brew install node@22 coreutils findutils flock
   export PATH="$(brew --prefix node@22)/bin:$HOME/.local/bin:$(brew --prefix coreutils)/libexec/gnubin:$(brew --prefix findutils)/libexec/gnubin:$(brew --prefix)/bin:$PATH"
   npm install --global --prefix "$HOME/.local" @usine/server
   mkdir -p "$HOME/factory/.usine/upgrade" "$HOME/Library/LaunchAgents"
   chmod 700 "$HOME/factory/.usine" "$HOME/factory/.usine/upgrade"
   touch "$HOME/factory/.env"
   chmod 600 "$HOME/factory/.env"
   printf 'USINE_LAUNCHD_SERVICE=gui/%s/dev.usine\n' "$(id -u)" >> "$HOME/factory/.env"
   ```

   The helper uses GNU `stat`, `df`, `sort`, `find`, and `timeout`, plus `flock`. Both jobs need the PATH shown below, including the `gnubin` directories. It upgrades the global npm prefix; keep one instance per prefix.

2. Save `~/Library/LaunchAgents/dev.usine.plist`:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>dev.usine</string>
     <key>ProgramArguments</key>
     <array>
       <string>/opt/homebrew/opt/node@22/bin/node</string>
       <string>/Users/usine/.local/lib/node_modules/@usine/server/dist/main.js</string>
       <string>up</string>
     </array>
     <key>WorkingDirectory</key><string>/Users/usine/factory</string>
     <key>EnvironmentVariables</key>
     <dict>
       <key>HOME</key><string>/Users/usine</string>
       <key>PATH</key><string>/opt/homebrew/opt/node@22/bin:/Users/usine/.local/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
     </dict>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>ThrottleInterval</key><integer>10</integer>
     <key>ExitTimeOut</key><integer>300</integer>
     <key>StandardOutPath</key><string>/Users/usine/factory/.usine/usine.log</string>
     <key>StandardErrorPath</key><string>/Users/usine/factory/.usine/usine.log</string>
     <key>Umask</key><integer>63</integer>
   </dict>
   </plist>
   ```

   Keep `up` in the foreground. `ExitTimeOut` gives shutdown up to 300 seconds before launchd terminates the process. The orchestrator reads the instance's `.env`; jobs inherit no terminal shell settings. Set worker credentials there and include any local worker harnesses in PATH.

3. Save `~/Library/LaunchAgents/dev.usine-upgrade.plist`:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>dev.usine-upgrade</string>
     <key>ProgramArguments</key>
     <array>
       <string>/bin/bash</string>
       <string>/Users/usine/factory/.usine/upgrade/run.sh</string>
     </array>
     <key>WorkingDirectory</key><string>/Users/usine/factory</string>
     <key>EnvironmentVariables</key>
     <dict>
       <key>HOME</key><string>/Users/usine</string>
       <key>PATH</key><string>/opt/homebrew/opt/node@22/bin:/Users/usine/.local/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
     </dict>
     <key>RunAtLoad</key><false/>
     <key>KeepAlive</key><false/>
     <key>StandardOutPath</key><string>/Users/usine/factory/.usine/upgrade/helper.log</string>
     <key>StandardErrorPath</key><string>/Users/usine/factory/.usine/upgrade/helper.log</string>
     <key>Umask</key><integer>63</integer>
   </dict>
   </plist>
   ```

   The server writes `run.sh` before `launchctl kickstart` starts the helper. Keep `RunAtLoad` and `KeepAlive` false for this job so login and helper exits do not repeat an upgrade. If you change the server label, use that label plus `-upgrade` for the helper.

4. Validate and load both jobs from the owning user's login session, without `sudo`:

   ```sh
   plutil -lint "$HOME/Library/LaunchAgents/dev.usine.plist" "$HOME/Library/LaunchAgents/dev.usine-upgrade.plist"
   chmod 600 "$HOME/Library/LaunchAgents/dev.usine.plist" "$HOME/Library/LaunchAgents/dev.usine-upgrade.plist"
   launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.usine-upgrade.plist"
   launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.usine.plist"
   cd "$HOME/factory"
   usine status
   usine sign-in-link
   ```

   Open the sign-in link locally and complete GitHub App setup and first-admin enrollment. `status` reports `gui/<uid>/dev.usine, managed with launchctl` once the instance owns its lock.

## Sleep and HTTPS

Keep the Mac on AC power and disable system sleep on AC power:

```sh
sudo pmset -c sleep 0
pmset -g custom
```

The display can still sleep. `caffeinate -s` prevents system sleep while that command runs, but stops when its session ends. Closing a laptop lid can still suspend it.

Install and connect Tailscale, enable HTTPS for the tailnet, and publish only the loopback listener:

```sh
tailscale serve --bg http://127.0.0.1:7331
```

Set `USINE_ORIGIN` in `~/factory/.env` to the HTTPS URL that Tailscale prints. Update the GitHub App callback to that origin plus `/api/auth/callback`, then run `usine restart` from the instance folder. See [expose an instance](/guides/expose-an-instance/) for access and origin settings.

## Lifecycle and upgrades

Run lifecycle commands as the owning user from `~/factory`. `usine stop` uses `launchctl bootout` so KeepAlive does not restart the job. `usine restart` unloads and bootstraps it again, then uses `kickstart`. After a stop, `usine up --detach` reloads `~/Library/LaunchAgents/dev.usine.plist`. The configured plist controls launch arguments; detached-start flags do not change it. A later login loads the plist again. Remove the server plist after stopping it if you want it to stay disabled across logins.

`usine upgrade --check` and **Configuration > Settings** use the same channels and idle-drain policy as managed Linux installations. The helper backs up both stores, unloads the server, installs the target package, loads the server, and checks version and readiness. A failed install or readiness check restores the prior package and databases before restarting it. Failed recovery leaves the server stopped. Read [upgrade an instance](/guides/upgrade-an-instance/) for backup retention and recovery.

Set `USINE_UPGRADE_BACKUP_DIR` and `USINE_UPGRADE_BACKUP_KEEP` in the helper plist's `EnvironmentVariables` to change backup storage or retention. Reload the helper after editing its plist, while no upgrade runs:

```sh
launchctl bootout "gui/$(id -u)/dev.usine-upgrade"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.usine-upgrade.plist"
```

## Check the result

```sh
launchctl print "gui/$(id -u)/dev.usine"
curl --fail http://127.0.0.1:7331/api/ready
tail -n 80 "$HOME/factory/.usine/usine.log"
tail -n 80 "$HOME/factory/.usine/upgrade/helper.log"
```

After startup recovery, readiness returns `{"ok":true}`. Test `usine stop`, `usine up --detach`, and `usine restart`, and confirm that each new PID appears in `launchctl print` and `usine status`. On the Mac, verify recovery after a process crash and after reboot and login. Before relying on managed upgrades, test a release upgrade and a failed upgrade on a separate instance with recoverable backups. Rotate the two log files as part of host maintenance.
