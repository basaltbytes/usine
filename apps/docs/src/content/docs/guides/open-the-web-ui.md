---
title: Open the web UI
description: Open a local instance or forward its port over SSH.
---

Connect a browser to a running instance and open a project board.

## Prerequisites

A running instance and an enrolled member with project access, or access to the instance machine for a one-time sign-in link.

## Procedure

1. For a local instance, open `http://127.0.0.1:7331`, using its configured port if different. For an SSH-only remote instance, forward its loopback listener:

   ```sh
   ssh -N -L 7331:127.0.0.1:7331 orchestrator.example.com
   ```

2. Sign in with GitHub, or run `usine sign-in-link` in the instance folder and open the printed private link. The link expires after ten minutes and works once.
3. Select a project in the sidebar, then **Board** or **Tasks**.

## Check the result

The UI lists only projects you can read. A project board combines its repositories and links to task and run pages. If no project appears, ask an instance admin to check your role bindings.

For a shared address, [expose the instance over HTTPS](/guides/expose-an-instance/). Authentication is required on loopback as well as through a proxy.

## Live updates

An open screen receives change notices over one server-sent events connection and reads only the affected data. The refresh indicator reports when live updates disconnect. During disconnection, the screen checks for changes every minute and resumes live updates when the connection recovers.

During sustained activity, ongoing reads finish and update the screen. Changes received during a read trigger a subsequent refresh, so the screen continues updating while attempts produce new output.

Opening **Configuration > Workers** loads current worker state, including changes made while you viewed another screen. If an admin removes the project you are viewing, its board and task list display **Project not found** after the next refresh. The page names the project ID from the URL. A legacy `/projects/<owner>/<name>` URL whose repository no project includes shows the same page with the repository name. When the first segment of such a URL is an existing project ID, the page reads **Page not found** and names the project and the unknown page instead. A run URL whose run belongs to another project shows **Run not found** with the run and the project from the URL. The other pages point to **Configuration > Projects**, where admins manage projects.

The **No project access** page checks permissions every minute. When an admin grants access, the page opens your projects automatically. Task pages refresh after label changes on any linked item and merge conflict changes on any linked pull request, including older pull requests. Task history menus refresh for the same linked-item changes. Linking an issue to an open pull-request task refreshes its title, membership, history, and task links. Resetting or closing a cycle-budget ask clears the task’s **Needs you** state when no other finding needs attention, including while its loop is paused.

Open run drawers and run pages refresh during machine preparation and quota backoff, including for members with project access only. They also refresh after configuration changes. If an agent definition changes, failed runs show the warning that **Edit and retry** uses the current definition.

Every board lane stays in one row. **Unmapped** holds tasks that match no lane and starts open while it holds an open issue or pull request. Lanes that hold only closed items, such as **Done**, and **Unmapped** with no open item start folded to a rail with their count. Select a rail to open its lane, and select the fold button in the lane header to fold it again. Your browser remembers each choice for that lane of the project.

Board moves appear immediately. A failed label write restores the card's previous lane and displays the error. An accepted move remains visible until GitHub synchronization confirms the lane. Open **Done** and scroll to load all its cards; loaded cards support **Move to** and dragging to a writable lane. Long lanes and run histories load more rows as you scroll.

**Runs without a card** includes only runs whose items have no board card. Runs on cards in **Done** stay out of this section, including before you load the lane.

If you serve the UI through a reverse proxy, disable response buffering for `/api/changes` and allow a long-lived response. The endpoint sends a heartbeat every 15 seconds.

Change notices publish after state writes commit. The stream filters identifiers using your current project access and checks credentials before each notice and every 15 seconds. Reconnecting replays up to 256 notices; an expired cursor or a slow connection requests a fresh read. Elapsed times update in the browser from recorded timestamps.

Pool rate warnings clear at their recorded reset times, including after the orchestrator restarts. A newer report replaces the previous reset times.

Unchanged GitHub polls keep the board’s cached activity data. The last-checked time refreshes on the next state change or manual refresh.
