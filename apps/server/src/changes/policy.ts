import type { Project } from "@usine/config/project";
import {
  InstanceScope,
  ProjectScope,
  permits,
  type AccessScope,
  type PermissionGrant,
} from "@usine/core/access";
import type { ChangeAudience, ChangeTarget } from "@usine/core/changes";
import { ProjectId } from "@usine/core/project";
import { Match, Option, Schema } from "effect";

type AudienceScope = AccessScope | Extract<ChangeAudience, { readonly _tag: "Readers" }>;
const decodeProject = Schema.decodeUnknownOption(ProjectId);
const projectScope = (project: Option.Option<ProjectId>): AccessScope =>
  Option.match(project, {
    onNone: () => InstanceScope.make(),
    onSome: (project) => ProjectScope.make({ project }),
  });

export const audienceScope = (
  audience: ChangeAudience,
  projects: ReadonlyArray<Project>,
): AudienceScope =>
  Match.valueTags(audience, {
    Instance: (scope) => scope,
    Project: (scope) => scope,
    Readers: (scope) => scope,
    Repository: ({ repository }) =>
      projectScope(
        Option.fromUndefinedOr(projects.find((project) => project.includes(repository))?.id),
      ),
    Loop: ({ loop }) => projectScope(decodeProject(loop.split("/")[0])),
  });

export const authorize = (grants: ReadonlyArray<PermissionGrant>, scope: AudienceScope): boolean =>
  Match.valueTags(scope, {
    Readers: () => grants.some(({ permission }) => permission === "read" || permission === "admin"),
    Instance: (scope) => permits(grants, "read", scope),
    Project: (scope) => permits(grants, "read", scope),
  });

export const expandTarget = (
  target: ChangeTarget,
  project: Option.Option<ProjectId>,
): ReadonlyArray<ChangeTarget> => {
  if (target.kind === "activity" || target.kind === "navigation") return [target];
  return [
    target,
    ...Option.match(project, {
      onNone: () => [],
      onSome: (id): ReadonlyArray<ChangeTarget> => [{ kind: "project", id }],
    }),
    { kind: "attention", id: "instance" },
    { kind: "activity", id: "instance" },
    ...(target.kind === "worker" ? [] : [{ kind: "navigation", id: "instance" } as const]),
  ];
};
