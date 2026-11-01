import { Context, Effect, Schema } from "effect";
import { ProjectId } from "./project.ts";

/** GitHub's stable numeric member identity, preserved across login changes. */
export const GitHubUserId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("GitHubUserId"),
);
export type GitHubUserId = typeof GitHubUserId.Type;
export const ProjectRole = Schema.Literals(["viewer", "operator", "maintainer"]);
export type ProjectRole = typeof ProjectRole.Type;
export const Permission = Schema.Literals(["read", "operate", "maintain", "admin"]);
export type Permission = typeof Permission.Type;

export class InstanceScope extends Schema.TaggedClass<InstanceScope>("InstanceScope")(
  "Instance",
  {},
) {}
export class ProjectScope extends Schema.TaggedClass<ProjectScope>("ProjectScope")("Project", {
  project: ProjectId,
}) {}
export const AccessScope = Schema.Union([InstanceScope, ProjectScope]);
export type AccessScope = typeof AccessScope.Type;

export class PermissionGrant extends Schema.Class<PermissionGrant>("PermissionGrant")(
  Schema.Struct({ permission: Permission, scope: AccessScope }).check(
    Schema.makeFilter(
      ({ permission, scope }) => permission !== "admin" || scope._tag === "Instance",
      {
        message: "Admin permission requires instance scope",
      },
    ),
  ),
) {}
export const administratorPermissions = [
  new PermissionGrant({ permission: "admin", scope: new InstanceScope() }),
];

export class RoleBinding extends Schema.Class<RoleBinding>("RoleBinding")(
  Schema.Struct({
    name: Schema.NonEmptyString,
    member: GitHubUserId,
    role: Schema.Literals(["admin", ...ProjectRole.literals]),
    scope: AccessScope,
  }).check(
    Schema.makeFilter(({ role, scope }) => (role === "admin") === (scope._tag === "Instance"), {
      message:
        "Admin bindings require instance scope; viewer, operator, and maintainer bindings require a project",
    }),
  ),
) {
  get permissions(): ReadonlyArray<PermissionGrant> {
    const permissions: ReadonlyArray<Permission> =
      this.role === "admin"
        ? ["admin"]
        : this.role === "maintainer"
          ? ["read", "operate", "maintain"]
          : this.role === "operator"
            ? ["read", "operate"]
            : ["read"];
    return permissions.map((permission) => new PermissionGrant({ permission, scope: this.scope }));
  }
}

/** Checks an explicit permission grant or the instance admin grant. */
export const permits = (
  grants: ReadonlyArray<PermissionGrant>,
  permission: Permission,
  scope: AccessScope,
): boolean =>
  grants.some(
    (grant) =>
      grant.permission === "admin" ||
      (grant.permission === permission &&
        (grant.scope._tag === "Instance" ||
          (scope._tag === "Project" && grant.scope.project === scope.project))),
  );

/** Intersects a token's ceiling with the member's current grants. */
export const intersectPermissions = (
  member: ReadonlyArray<PermissionGrant>,
  ceiling: ReadonlyArray<PermissionGrant>,
): ReadonlyArray<PermissionGrant> => {
  if (ceiling.some(({ permission }) => permission === "admin")) return member;
  return ceiling.flatMap((grant) => {
    if (permits(member, grant.permission, grant.scope)) return [grant];
    if (grant.scope._tag === "Project") return [];
    return member.filter((candidate) => candidate.permission === grant.permission);
  });
};

/** Internal callers have instance access; HTTP boundaries always provide the authenticated grants. */
export const RequestPermissions = Context.Reference<ReadonlyArray<PermissionGrant>>(
  "@usine/core/RequestPermissions",
  {
    defaultValue: () => administratorPermissions,
  },
);
export class AccessDenied extends Schema.TaggedError<AccessDenied>("AccessDenied")("AccessDenied", {
  permission: Permission,
}) {}
export const requirePermission = Effect.fn("Authorization.requirePermission")(function* (
  permission: Permission,
  scope: AccessScope,
) {
  yield* Effect.annotateCurrentSpan({
    permission,
    scope: scope._tag,
    project: scope._tag === "Project" ? scope.project : "instance",
  });
  if (permits(yield* RequestPermissions, permission, scope)) return;
  yield* Effect.logWarning("Permission refused", { permission, scope });
  return yield* new AccessDenied({ permission });
});
