---
title: Grant member access
description: Enroll a member and grant a project or instance role.
---

Enroll a GitHub member and grant the role needed for a project.

## Prerequisites

An authenticated instance admin session and the member’s GitHub login.

## Procedure

1. Open **Members** and add the GitHub login.
2. Select **Add binding** beside the member, then enter a binding name and select **Continue**. The form preselects the member by login. Select a project under **Scope** and choose role `viewer`, `operator`, or `maintainer`. Select **Instance** to grant the `admin` role.
3. Save the binding and ask the member to sign in through GitHub.

You can also create a binding from **Configuration > Role bindings > New role binding** and select a member by login. Members lists each binding as a link to its editor. Select **Edit as text** to use the export format; switching back to the form preserves the draft. Saved changes and deletions appear in the binding’s history with the acting member.

## Check the result

The member can see the bound project and use the actions allowed by its role. A newly enrolled member has no project access until a binding grants it. Existing browser sessions use changed bindings on their next request.

Removing a member revokes their tokens and deletes their bindings. The UI refuses removal of the last member or last admin member. [Access reference](/reference/access/) describes roles, device ceilings, and local recovery.
