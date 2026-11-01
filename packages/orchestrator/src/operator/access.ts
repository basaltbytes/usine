import {
  AccessDenied,
  InstanceScope,
  ProjectScope,
  RequestPermissions,
  permits,
  requirePermission,
  type PermissionGrant,
} from "@usine/core/access";
import { ProjectId } from "@usine/core/project";
import type { LoopName } from "@usine/core/loop";
import type { RepositoryName } from "@usine/core/repository";
import { LoadedInstance } from "@usine/config/instance";
import { UsineConfig } from "@usine/config/factory";
import { Effect, Option, Schema } from "effect";
import type { ConfigurationEntityKey } from "@usine/config/configuration";
import { needRepositories } from "./attention.ts";
import { ReadyOverview } from "./overview.ts";
import type { NeedView } from "./need.ts";

export const loopScope = (loop: string) => {
  const project = loop.includes("/")
    ? Schema.decodeUnknownOption(ProjectId)(loop.split("/")[0])
    : Option.none();
  return Option.match(project, {
    onNone: () => new InstanceScope(),
    onSome: (project) => new ProjectScope({ project }),
  });
};
export const repositoryScope = (instance: LoadedInstance, repository: RepositoryName) => {
  const project = instance.config.projects.find((project) => project.includes(repository));
  return project === undefined ? new InstanceScope() : new ProjectScope({ project: project.id });
};
export const visibleRepository = (
  instance: LoadedInstance,
  grants: ReadonlyArray<PermissionGrant>,
  repository: RepositoryName,
) => permits(grants, "read", repositoryScope(instance, repository));
export const visibleLoop = (grants: ReadonlyArray<PermissionGrant>, loop: LoopName) =>
  permits(grants, "read", loopScope(loop));
const visibleNeed = (
  instance: LoadedInstance,
  grants: ReadonlyArray<PermissionGrant>,
  need: NeedView,
) => {
  if (permits(grants, "admin", new InstanceScope())) return true;
  const repositories = needRepositories(need);
  return (
    repositories.length > 0 &&
    repositories.every((repository) => visibleRepository(instance, grants, repository))
  );
};
export const filterOverview = (instance: LoadedInstance, view: ReadyOverview) =>
  Effect.map(RequestPermissions, (grants) => {
    if (permits(grants, "admin", new InstanceScope())) return view;
    const fields = {
      projects: view.projects.filter((project) =>
        visibleRepository(instance, grants, project.repository),
      ),
      loops: view.loops.filter((loop) => visibleLoop(grants, loop.name)),
      needsYou: view.needsYou.filter((need) => visibleNeed(instance, grants, need)),
      dismissedNeeds: view.dismissedNeeds.filter((need) => visibleNeed(instance, grants, need)),
    };
    return new ReadyOverview(fields);
  });
export const visibleInstance = (instance: LoadedInstance) =>
  Effect.map(RequestPermissions, (grants) => {
    if (permits(grants, "admin", new InstanceScope())) return instance;
    return new LoadedInstance({
      ...instance,
      config: new UsineConfig({
        ...instance.config,
        bindings: [],
        projects: instance.config.projects.filter(({ id }) =>
          permits(grants, "read", new ProjectScope({ project: id })),
        ),
        repos: instance.config.repos.filter(({ name }) =>
          visibleRepository(instance, grants, name),
        ),
        // Configuration requires at least one worker; statistics suppress worker aggregates separately.
      }),
      loops: instance.loops.filter(({ name }) => visibleLoop(grants, name)),
    });
  });

export const entityPermission = (key: ConfigurationEntityKey, permission: "read" | "maintain") => {
  if (key.kind === "loop") return requirePermission(permission, loopScope(key.identifier));
  if (key.kind === "project")
    return Schema.decodeUnknownEffect(ProjectId)(key.identifier).pipe(
      Effect.mapError(() => new AccessDenied({ permission })),
      Effect.flatMap((project) => requirePermission(permission, new ProjectScope({ project }))),
    );
  return requirePermission("admin", new InstanceScope());
};
