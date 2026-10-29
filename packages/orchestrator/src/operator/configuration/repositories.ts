import { Project } from "@usine/config/project";
import {
  Configuration,
  ConfigurationChange,
  ConfigurationEntity,
  ConfigurationInvalid,
  ConfigurationEntityKey,
  ConfigurationEntityId,
} from "@usine/config/configuration";
import { ManagedRepo } from "@usine/config/factory";
import { ConfigFileError, InstancePath } from "@usine/config/file";
import { Effect, Option, Schema } from "effect";

/** Keeps the repository editor's lane fields working for a project with one repository. */
export const repositoryEditorEntity = (
  snapshot: Configuration,
  entity: ConfigurationEntity,
): ConfigurationEntity => {
  if (entity.key.kind !== "repository" || Option.isNone(snapshot.instance)) return entity;
  const { config } = snapshot.instance.value;
  const repository = config.repos.find(({ name }) => name === String(entity.key.identifier));
  const project = config.projects.find(
    (project) =>
      project.repositories.length === 1 &&
      project.repositories.some((name) => name === String(entity.key.identifier)),
  );
  if (repository === undefined || project === undefined) return entity;
  return new ConfigurationEntity({
    ...entity,
    value: Schema.encodeSync(ManagedRepo)(new ManagedRepo({ ...repository, lanes: project.lanes })),
  });
};

export const repositoryEditorChanges = (snapshot: Configuration, entity: ConfigurationEntity) =>
  Effect.gen(function* () {
    if (
      entity.key.kind !== "repository" ||
      Option.isNone(snapshot.instance) ||
      snapshot.instance.value.config.version === 1
    )
      return { entity, changes: [] };
    const fields = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(entity.value).pipe(
      Effect.mapError(
        (error) =>
          new ConfigurationInvalid({
            problems: [ConfigFileError.fromSchema(InstancePath.make(entity.key.key), error)],
          }),
      ),
    );
    if (!("lanes" in fields)) return { entity, changes: [] };
    const repository = yield* Schema.decodeUnknownEffect(ManagedRepo)(fields, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (error) =>
          new ConfigurationInvalid({
            problems: [ConfigFileError.fromSchema(InstancePath.make(entity.key.key), error)],
          }),
      ),
    );
    const project = snapshot.instance.value.config.projects.find((project) =>
      project.includes(repository.name),
    );
    if (project === undefined || project.repositories.length !== 1) return { entity, changes: [] };
    const before = Schema.encodeSync(Project)(project);
    const key = new ConfigurationEntityKey({
      kind: "project",
      identifier: ConfigurationEntityId.make(project.id),
    });
    const { lanes, ...value } = fields;
    return {
      entity: new ConfigurationEntity({ ...entity, value }),
      changes: [
        new ConfigurationChange({
          key,
          before: Option.some(before),
          after: Option.some({ ...before, lanes }),
        }),
      ],
    };
  });
