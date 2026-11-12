---
title: Access
description: Member roles, role bindings, sessions, device tokens, and local access.
---

Members sign in with GitHub. Role bindings determine project access and instance administration. Manage enrollment under **Members** and grants under **Configuration > Role bindings**.

## Role binding

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | non-empty string | required | Unique binding identity. |
| `member` | positive integer | required | Stable numeric GitHub user ID. |
| `role` | `viewer`, `operator`, `maintainer`, or `admin` | required | Cumulative access granted to the member. |
| `scope` | tagged scope | required | Project scope for project roles or instance scope for admin. |

Edit one binding with `usine config edit binding alice-widgets`:

```yaml
name: alice-widgets
member: 12345
role: maintainer
scope:
  _tag: Project
  project: widgets
```

An instance admin binding uses `role: admin` and `scope: { _tag: Instance }`. Project scopes must reference an existing project. A binding prepared for a numeric ID grants access only after that account enrolls. Identity checks use numeric IDs, so reusing a former login cannot impersonate a member.

## Roles

| Role | Scope | Default | Description |
| --- | --- | --- | --- |
| `viewer` | project | no automatic grant | Read tasks, runs, transcripts, loops, and lanes. |
| `operator` | project | no automatic grant | Viewer access plus approve, retry, cancel, message, pause, reset budgets, and move cards. |
| `maintainer` | project | no automatic grant | Operator access plus edit loops and project lanes. |
| `admin` | instance | first member | All operations, including membership, bindings, workers, registry, settings, and upgrades. |

Roles on a project accumulate across bindings. Lists omit projects without read access, including their attention items. Shared agents and non-secret settings remain readable to members with project read access. Removing a member revokes tokens and deletes bindings; the UI protects the last member and last admin member from removal.

## Credentials

| Credential | Type | Default lifetime | Description |
| --- | --- | --- | --- |
| Browser session | HttpOnly cookie | 30 days | Follows current member bindings on every request and requires a CSRF header for writes. |
| Device token | bearer token | until revoked, or until its expiry | Intersects its permission ceiling with current member bindings on every request. An operation ceiling limits it to the listed operations. |
| One-time sign-in link | private URL | 10 minutes | Opens a member browser session once and permits first-member enrollment through local access. |
| Local admin token | private file | one process start | Gives the built-in local actor instance admin access without a member identity. |

`usine sign-in <origin>` issues a device token after GitHub authorization. **Tokens** lists browsers and devices with creation and last-use times. Secrets appear once; the instance stores hashes. Revoking an entry ends its access. Device scopes cannot exceed the caller’s effective permissions. Read, operate, and maintain scopes are independent, so include read for clients that fetch data before acting. Browser sessions have no editable ceiling. A device token can also have an operation ceiling, the operation IDs that it may call, such as `operator.approve`; reading its session and signing out stay allowed. An expiry, set at creation, ends a device token's access at that time.

The local admin token is `.usine/admin-token`, a regular file owned by the service user with mode `0600`. Startup replaces it. Local lifecycle commands reject unsafe files before sending signals. Local writes and configuration CLI revisions record **local admin**. If binding edits remove admin access, use the configuration CLI on the instance machine to restore it.

Health, sign-in, the OpenAPI schema, and the release-string version endpoint are public. Other operator routes require a session or bearer token. The webhook endpoint checks GitHub signatures separately. [Sign in](/guides/sign-in/) and [grant member access](/guides/manage-members/) provide procedures.
