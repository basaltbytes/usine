import { assert, it } from "vitest";
import { Option, Schema } from "effect";
import {
  GitHubUserId,
  InstanceScope,
  ProjectScope,
  RoleBinding,
  PermissionGrant,
  permits,
  intersectPermissions,
} from "../src/access.ts";
import { ProjectId } from "../src/project.ts";
const alpha = new ProjectScope({ project: ProjectId.make("alpha") });
const beta = new ProjectScope({ project: ProjectId.make("beta") });
const binding = (role: "viewer" | "operator" | "maintainer") =>
  new RoleBinding({ name: role, member: GitHubUserId.make(1), role, scope: alpha });
it("rejects mismatched role scopes at construction", () => {
  for (const value of [
    { name: "bad", member: 1, role: "admin", scope: alpha },
    { name: "bad", member: 1, role: "viewer", scope: new InstanceScope() },
  ])
    assert.isTrue(Option.isNone(Schema.decodeUnknownOption(RoleBinding)(value)));
});
it("grants project actions cumulatively without granting another project or instance administration", () => {
  for (const [role, expected] of [
    ["viewer", [true, false, false]],
    ["operator", [true, true, false]],
    ["maintainer", [true, true, true]],
  ] as const) {
    const grants = binding(role).permissions;
    assert.deepEqual(
      (["read", "operate", "maintain"] as const).map((permission) =>
        permits(grants, permission, alpha),
      ),
      [...expected],
    );
    assert.isFalse(permits(grants, "read", beta));
    assert.isFalse(permits(grants, "admin", new InstanceScope()));
  }
});
it("intersects token ceilings with current membership, including narrowed instance read scopes", () => {
  const ceiling = [new PermissionGrant({ permission: "read", scope: new InstanceScope() })];
  const effective = intersectPermissions(binding("maintainer").permissions, ceiling);
  assert.isTrue(permits(effective, "read", alpha));
  assert.isFalse(permits(effective, "read", beta));
  assert.isFalse(permits(effective, "operate", alpha));
  assert.deepEqual(intersectPermissions([], ceiling), []);
});
