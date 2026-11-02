---
title: Open the web UI
description: Connect to the local web UI or forward its port over SSH.
---

## Open the web UI

The UI is at `http://127.0.0.1:7331`, or on the port you set. The server listens only on the loopback interface and requires sign-in, including for local access. Sign in with GitHub after setup, or run `usine sign-in-link` in the instance folder to generate a one-time link. It refuses browser requests from pages on non-loopback origins, other than the URL of a proxy that [`--origin`](/reference/cli/#usine-up) sets, so other websites can't use it through your browser. To use the UI from another computer, forward the port over SSH, or publish it on your tailnet as in [Run the orchestrator on a server](/guides/run-the-orchestrator-on-a-server/#keep-the-ui-private):

```sh title="Your computer"
ssh -N -L 7331:127.0.0.1:7331 orchestrator.example.com
```

The sidebar lists projects by display name, with **Board** and **Tasks** for each project. A project combines one or more repositories in one board. **Configuration > Projects** edits display names, ordered repositories, and shared lanes; **Repositories** manages registry entries. Configuration edits save revisions and apply live. [Operate runs](/guides/operate-runs/) describes each screen.
