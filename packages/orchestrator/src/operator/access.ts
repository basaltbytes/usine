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
    onNone: () => InstanceScope.make(),
    onSome: (project) => ProjectScope.make({ project }),
  });
};
export const repositoryScope = (instance: LoadedInstance, repository: RepositoryName) => {
  const project = instance.config.projects.find((project) => project.includes(repository));
  return project === undefined ? InstanceScope.make() : ProjectScope.make({ project: project.id });
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
  if (permits(grants, "admin", InstanceScope.make())) return true;
  const repositories = needRepositories(need);
  return (
    repositories.length > 0 &&
    repositories.every((repository) => visibleRepository(instance, grants, repository))
  );
};
export const filterOverview = (instance: LoadedInstance, view: ReadyOverview) =>
  Effect.map(RequestPermissions, (grants) => {
    if (permits(grants, "admin", InstanceScope.make())) return view;
    const fields = {
      projects: view.projects.filter((project) =>
        visibleRepository(instance, grants, project.repository),
      ),
      loops: view.loops.filter((loop) => visibleLoop(grants, loop.name)),
      needsYou: view.needsYou.filter((need) => visibleNeed(instance, grants, need)),
      dismissedNeeds: view.dismissedNeeds.filter((need) => visibleNeed(instance, grants, need)),
    };
    return ReadyOverview.make(fields);
  });
export const visibleInstance = (instance: LoadedInstance) =>
  Effect.map(RequestPermissions, (grants) => {
    if (permits(grants, "admin", InstanceScope.make())) return instance;
    return LoadedInstance.make({
      ...instance,
      config: UsineConfig.make({
        ...instance.config,
        bindings: [],
        projects: instance.config.projects.filter(({ id }) =>
          permits(grants, "read", ProjectScope.make({ project: id })),
        ),
        repos: instance.config.repos.filter(({ name }) =>
          visibleRepository(instance, grants, name),
        ),
      }),
      loops: instance.loops.filter(({ name }) => visibleLoop(grants, name)),
    });
  });

export const entityPermission = (key: ConfigurationEntityKey, permission: "read" | "maintain") => {
  if (key.kind === "loop") return requirePermission(permission, loopScope(key.identifier));
  if (key.kind === "project")
    return Schema.decodeEffect(ProjectId)(key.identifier).pipe(
      Effect.mapError(() => AccessDenied.make({ permission })),
      Effect.flatMap((project) => requirePermission(permission, ProjectScope.make({ project }))),
    );
  return requirePermission("admin", InstanceScope.make());
};
