---
title: Grant member access
description: Enroll a member and grant a project or instance role.
---

Enroll a GitHub member and grant the role needed for a project.

## Prerequisites

An authenticated instance admin session and the member’s GitHub login.

## Procedure

1. Open **Members** and add the GitHub login. Verify the numeric GitHub ID shown for the enrolled account.
2. Open **Configuration > Role bindings** and create a named binding. Set the numeric member ID, project scope, and role `viewer`, `operator`, or `maintainer`. Use role `admin` with instance scope only for instance administrators.
3. Save the binding and ask the member to sign in through GitHub.

## Check the result

The member can see the bound project and use the actions allowed by its role. A newly enrolled member has no project access until a binding grants it. Existing browser sessions use changed bindings on their next request.

Removing a member revokes their tokens and deletes their bindings. The UI refuses removal of the last member or last admin member. [Access reference](/reference/access/) describes roles, device ceilings, and local recovery.
