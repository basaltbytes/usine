---
title: Run usine locally
description: Install usine, start an instance on your machine, and open its web UI.
---

Run an instance on your Mac or Linux machine. The orchestrator runs while its machine stays awake.

## Prerequisites

macOS or Linux with Node.js 22.22 or later, npm, Git, and a GitHub account that can create and install a GitHub App. Use a folder on persistent storage for the instance.

## Procedure

1. Install the CLI as the Unix user who will run the instance:

   ```sh
   npm install --global @usine/server
   usine --version
   ```

   Confirm that the command prints a release number. The package includes the web UI.

2. Create an instance folder and start the orchestrator:

   ```sh
   mkdir -p ~/usine-instance
   cd ~/usine-instance
   usine up
   ```

   The first start initializes empty configuration in `.usine/runtime.sqlite` and prints `usine is running in setup mode at http://127.0.0.1:7331`. Keep this terminal open.

3. Open the printed one-time sign-in link. If the browser does not open or the link expires, run `usine sign-in-link` from the same instance folder in another terminal. In setup, create the GitHub App, install it on the repositories you want to use, and sign in with GitHub to enroll the first instance admin. Select **Open usine** to activate the runtime.
4. Open `http://127.0.0.1:7331` to return to the web UI. Add repositories and projects through setup, then [configure a worker](/guides/workers/) and [write an agent and loop](/guides/loops-and-agents/) to run work. The [quickstart](/get-started/quickstart/) walks through credentials and a first pull request in a scratch repository.
5. To stop the instance, press Ctrl+C in the terminal running `usine up`, or run this command from the instance folder in another terminal:

   ```sh
   usine stop
   ```

   The orchestrator stops admitting work and waits for active attempts to finish. Run `usine up` from the same folder to start it again with its saved configuration.

## Check the result

While the instance runs, `usine status` from its folder reports its PID, version, uptime, and listener. The web UI opens setup or your signed-in instance. After stopping, `usine status` reports that the instance is stopped and exits with code 3.

To close the terminal while the instance runs, [start it detached](/guides/keep-the-orchestrator-running/). For an always-on machine, [host usine on a Linux server](/guides/host-usine-on-linux/).
