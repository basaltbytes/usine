import { Project } from "@usine/config/project";
import {
  InstanceScope,
  PermissionGrant,
  ProjectScope,
  administratorPermissions,
} from "@usine/core/access";
import type { ChangeAudience } from "@usine/core/changes";
import { LoopName } from "@usine/core/loop";
import { ProjectId } from "@usine/core/project";
import { RepositoryName } from "@usine/core/repository";
import { Option } from "effect";
import { expect, it } from "vitest";
import { audienceScope, authorize, expandTarget } from "../../src/changes/policy.ts";

const project = ProjectId.make("visible");
const repository = RepositoryName.make("owner/visible");
const scope = new ProjectScope({ project });
const projects = [new Project({ id: project, name: "Visible", repositories: [repository] })];

it("resolves repository and loop audiences without granting project readers orphaned notices", () => {
  const projectAudiences: ReadonlyArray<ChangeAudience> = [
    scope,
    { _tag: "Repository", repository: RepositoryName.make("OWNER/Visible") },
    { _tag: "Loop", loop: LoopName.make("visible/developer") },
  ];
  for (const audience of projectAudiences) expect(audienceScope(audience, projects)).toEqual(scope);
  expect(audienceScope({ _tag: "Readers" }, projects)).toEqual({ _tag: "Readers" });
  for (const audience of [
    new InstanceScope(),
    { _tag: "Repository", repository: RepositoryName.make("owner/removed") },
    { _tag: "Loop", loop: LoopName.make("invalid.project/developer") },
  ] as const) {
    const resolved = audienceScope(audience, projects);
    expect(resolved).toEqual(new InstanceScope());
    expect(authorize([new PermissionGrant({ permission: "read", scope })], resolved)).toBe(false);
  }
});

it("requires read access at the resolved scope and allows shared notices for any reader", () => {
  const other = new ProjectScope({ project: ProjectId.make("hidden") });
  const reader = [new PermissionGrant({ permission: "read", scope })];
  const instanceReader = [new PermissionGrant({ permission: "read", scope: new InstanceScope() })];
  for (const target of [scope, other, new InstanceScope(), { _tag: "Readers" } as const]) {
    expect(authorize(administratorPermissions, target)).toBe(true);
    expect(authorize(instanceReader, target)).toBe(true);
    expect(authorize([], target)).toBe(false);
    expect(authorize([new PermissionGrant({ permission: "operate", scope })], target)).toBe(false);
  }
  expect(authorize(reader, scope)).toBe(true);
  expect(authorize(reader, other)).toBe(false);
  expect(authorize(reader, new InstanceScope())).toBe(false);
  expect(authorize(reader, { _tag: "Readers" })).toBe(true);
});

it("expands entity targets after authorization while preserving narrow activity and worker updates", () => {
  const run = { kind: "run", id: "run" } as const;
  const dependencies = [
    { kind: "attention", id: "instance" },
    { kind: "activity", id: "instance" },
    { kind: "navigation", id: "instance" },
  ];
  expect(expandTarget(run, Option.some(project))).toEqual([
    run,
    { kind: "project", id: project },
    ...dependencies,
  ]);
  expect(expandTarget(run, Option.none())).toEqual([run, ...dependencies]);
  const worker = { kind: "worker", id: "worker" } as const;
  expect(expandTarget(worker, Option.none())).toEqual([worker, ...dependencies.slice(0, 2)]);
  for (const kind of ["activity", "navigation"] as const) {
    const target = { kind, id: "instance" };
    expect(expandTarget(target, Option.some(project))).toEqual([target]);
  }
});
