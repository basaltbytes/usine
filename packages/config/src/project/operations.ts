import { ProjectId } from "@usine/core/project";
import { LoopName } from "@usine/core/loop";
import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import { Option } from "effect";
import { ManagedRepo, UsineConfig } from "../factory.ts";
import { LoadedInstance } from "../instance/instance.ts";
import { LoopFile } from "../loop.ts";
import { DeclaredLabel, canonicalLabelName } from "../label.ts";
import { matchesSelector } from "../selector.ts";
import { Project } from "./project.ts";

export { Project } from "./project.ts";

export const matchesLoop = (
  config: UsineConfig,
  loop: LoopFile,
  repository: ManagedRepo,
): boolean =>
  matchesSelector(loop.selector, repository) &&
  (config.version === 1 ||
    config.projects.some(
      (project) => loop.name.startsWith(`${project.id}/`) && project.includes(repository.name),
    ));

/** Resolves an exact identifier or a short name that occurs in only one project. */
export const resolveLoopName = (
  loops: ReadonlyArray<LoopFile>,
  name: LoopName,
): Option.Option<LoopName> => {
  const matches = loops.filter(
    (loop) => loop.name === name || (!name.includes("/") && loop.name.endsWith(`/${name}`)),
  );
  return matches.length === 1 ? Option.fromUndefinedOr(matches[0]?.name) : Option.none();
};

/** Supplies project lanes to repository-scoped board readers, including the version 1 codec. */
export const boardRepositories = (config: UsineConfig): ReadonlyArray<ManagedRepo> =>
  config.version === 1
    ? config.repos
    : config.projects.flatMap((project) =>
        project.repositories.flatMap((name) =>
          config.repos
            .filter((repo) => canonicalRepositoryName(repo.name) === canonicalRepositoryName(name))
            .map((repo) => new ManagedRepo({ ...repo, lanes: project.lanes })),
        ),
      );

/** Converts the version 1 registry and selectors without changing agent or loop content. */
export const migrateProjects = (instance: LoadedInstance): LoadedInstance => {
  if (instance.config.version === 2) return instance;
  const used = new Set<string>();
  const projects = instance.config.repos.map((repository) => {
    const base =
      repository.name
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/gu, "-")
        .replaceAll(/^-|-$/gu, "") || "project";
    let slug = base;
    for (let suffix = 2; used.has(slug); suffix += 1) slug = `${base}-${suffix}`;
    used.add(slug);
    return new Project({
      id: ProjectId.make(slug),
      name: repository.name,
      repositories: [repository.name],
      lanes: repository.lanes,
    });
  });
  const loops = projects.flatMap((project) =>
    instance.config.repos
      .filter((repository) => project.includes(repository.name))
      .flatMap((repository) =>
        instance.loops
          .filter((loop) => matchesSelector(loop.selector, repository))
          .map(
            (loop) => new LoopFile({ ...loop, name: LoopName.make(`${project.id}/${loop.name}`) }),
          ),
      ),
  );
  return new LoadedInstance({
    ...instance,
    config: new UsineConfig({
      ...instance.config,
      version: 2,
      projects,
      repos: instance.config.repos.map((repo) => new ManagedRepo({ ...repo, lanes: [] })),
    }),
    loops,
    warnings: [],
  });
};

export const labelsForRepository = (
  config: UsineConfig,
  repository: RepositoryName,
): ReadonlyArray<DeclaredLabel> => {
  const labels = new Map(config.labels.map((label) => [canonicalLabelName(label.name), label]));
  for (const project of config.projects.filter((project) => project.includes(repository))) {
    for (const source of project.lanes.flatMap(({ sources }) => sources)) {
      if ("label" in source && !labels.has(canonicalLabelName(source.label)))
        labels.set(
          canonicalLabelName(source.label),
          new DeclaredLabel({
            name: source.label,
            color: Option.none(),
            description: Option.none(),
          }),
        );
    }
  }
  return [...labels.values()];
};
