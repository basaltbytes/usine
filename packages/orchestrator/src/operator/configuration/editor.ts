import {
  Configuration,
  ConfigurationChange,
  ConfigurationEntity,
  ConfigurationEntityKey,
  ConfigurationEntityKind,
  ConfigurationStore,
  StaleRevision,
  revertConfiguration,
  type ConfigurationRevertBlocked,
  configurationEntities,
  type ConfigurationInvalid,
  type ConfigurationRevision,
  type ConfigurationRevisionNumber,
  type ConfigurationStoreError,
} from "@usine/config/configuration";
import { formatConfigurationEntity, parseConfigurationEntity } from "@usine/config/folder-codec";
import { ConfigParser } from "@usine/config/parser";
import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  CurrentInstance,
  type InstanceReloadError,
} from "../../current-instance/current-instance.ts";
import {
  ConfigurationEntityRequest,
  ConfigurationEntityView,
  ConfigurationNotFound,
  ConfigurationReplacement,
  ConfigurationRevisionPage,
  ConfigurationRevisionQuery,
  ConfigurationRevisionSummary,
  ConfigurationWrite,
} from "./model.ts";

export type ConfigurationEditorError =
  | ConfigurationInvalid
  | ConfigurationStoreError
  | StaleRevision
  | ConfigurationNotFound
  | ConfigurationRevertBlocked
  | InstanceReloadError;

const entityKey = (request: ConfigurationEntityRequest) =>
  Schema.decodeUnknownEffect(ConfigurationEntityKey)(request).pipe(
    Effect.mapError(
      () => new ConfigurationNotFound({ message: `Unknown configuration kind: ${request.kind}` }),
    ),
  );

const entitiesOf = (configuration: Configuration) =>
  Option.match(configuration.instance, {
    onNone: () => [],
    onSome: configurationEntities,
  });

export class ConfigurationEditor extends Context.Service<
  ConfigurationEditor,
  {
    readonly list: (
      query: ConfigurationRevisionQuery,
    ) => Effect.Effect<ConfigurationRevisionPage, ConfigurationEditorError>;
    readonly revision: (
      number: ConfigurationRevisionNumber,
    ) => Effect.Effect<ConfigurationRevision, ConfigurationEditorError>;
    readonly entity: (
      request: ConfigurationEntityRequest,
    ) => Effect.Effect<ConfigurationEntityView, ConfigurationEditorError>;
    readonly replace: (
      request: ConfigurationEntityRequest,
      input: ConfigurationReplacement,
    ) => Effect.Effect<ConfigurationRevision, ConfigurationEditorError>;
    readonly remove: (
      request: ConfigurationEntityRequest,
      input: ConfigurationWrite,
    ) => Effect.Effect<ConfigurationRevision, ConfigurationEditorError>;
    readonly revert: (
      number: ConfigurationRevisionNumber,
      input: ConfigurationWrite,
    ) => Effect.Effect<ConfigurationRevision, ConfigurationEditorError>;
  }
>()("@usine/orchestrator/ConfigurationEditor") {
  static readonly layer = Layer.effect(
    ConfigurationEditor,
    Effect.gen(function* () {
      const store = yield* ConfigurationStore;
      const parser = yield* ConfigParser;
      const current = yield* CurrentInstance;

      const revision = Effect.fn("ConfigurationEditor.revision")(function* (
        number: ConfigurationRevisionNumber,
      ) {
        yield* Effect.annotateCurrentSpan({ revision: number });
        const found = yield* store.revision(number);
        if (Option.isNone(found))
          return yield* new ConfigurationNotFound({
            message: `Configuration revision ${number} was not found.`,
          });
        return found.value;
      });
      const snapshotFor = (expected: ConfigurationRevisionNumber) =>
        store.read.pipe(
          Effect.flatMap((snapshot) =>
            snapshot.number === expected
              ? Effect.succeed(snapshot)
              : Effect.fail(new StaleRevision({ expected, actual: snapshot.number })),
          ),
        );
      const save = (
        snapshot: Configuration,
        input: ConfigurationWrite,
        changes: ReadonlyArray<ConfigurationChange>,
      ) =>
        current.commit({
          expected: input.expected,
          changes,
          actor: snapshot.actor,
          message: Option.fromUndefinedOr(input.message),
        });
      const findEntity = (snapshot: Configuration, key: ConfigurationEntityKey) => {
        const found = entitiesOf(snapshot).find((entity) => entity.key.key === key.key);
        return found === undefined
          ? Effect.fail(
              new ConfigurationNotFound({
                message: `Configuration entity ${key.key} was not found.`,
              }),
            )
          : Effect.succeed(found);
      };

      return ConfigurationEditor.of({
        revision,
        list: Effect.fn("ConfigurationEditor.list")(function* (query) {
          if (query.kind !== undefined)
            yield* Schema.decodeUnknownEffect(ConfigurationEntityKind)(query.kind).pipe(
              Effect.mapError(
                () =>
                  new ConfigurationNotFound({
                    message: `Unknown configuration kind: ${query.kind}`,
                  }),
              ),
            );
          const history = yield* store.list(Option.none());
          const filtered = history
            .filter(
              ({ number, changes }) =>
                (query.before === undefined || number < query.before) &&
                ((query.kind === undefined && query.identifier === undefined) ||
                  changes.some(
                    ({ key }) =>
                      (query.kind === undefined || key.kind === query.kind) &&
                      (query.identifier === undefined || key.identifier === query.identifier),
                  )),
            )
            .sort((a, b) => b.number - a.number);
          const page = filtered.slice(0, query.limit);
          return new ConfigurationRevisionPage({
            revisions: page.map(
              (entry) =>
                new ConfigurationRevisionSummary({
                  ...entry,
                  actor: Option.getOrNull(entry.actor),
                  message: Option.getOrNull(entry.message),
                  entities: entry.changes.map(({ key }) => key),
                }),
            ),
            nextBefore: filtered.length > query.limit ? (page.at(-1)?.number ?? null) : null,
          });
        }),
        entity: Effect.fn("ConfigurationEditor.entity")(function* (request) {
          const key = yield* entityKey(request);
          yield* Effect.annotateCurrentSpan({ entity: key.key });
          const snapshot = yield* store.read;
          const entity = yield* findEntity(snapshot, key);
          return new ConfigurationEntityView({
            ...entity,
            text: yield* formatConfigurationEntity(entity),
            number: snapshot.number,
          });
        }),
        replace: Effect.fn("ConfigurationEditor.replace")(function* (request, input) {
          const key = yield* entityKey(request);
          yield* Effect.annotateCurrentSpan({ entity: key.key, expectedRevision: input.expected });
          const snapshot = yield* snapshotFor(input.expected);
          const entity =
            input.text !== undefined
              ? yield* parseConfigurationEntity(parser, key, input.text)
              : new ConfigurationEntity({ key, value: input.value });
          const before = entitiesOf(snapshot).find((entry) => entry.key.key === key.key);
          const change = {
            key,
            before: Option.fromUndefinedOr(before?.value),
            after: Option.some(entity.value),
          };
          return yield* save(snapshot, input, [
            new ConfigurationChange(
              input.position === undefined ? change : { ...change, position: input.position },
            ),
          ]);
        }),
        remove: Effect.fn("ConfigurationEditor.remove")(function* (request, input) {
          const key = yield* entityKey(request);
          yield* Effect.annotateCurrentSpan({ entity: key.key, expectedRevision: input.expected });
          const snapshot = yield* snapshotFor(input.expected);
          const entity = yield* findEntity(snapshot, key);
          return yield* save(snapshot, input, [
            new ConfigurationChange({
              key,
              before: Option.some(entity.value),
              after: Option.none(),
            }),
          ]);
        }),
        revert: Effect.fn("ConfigurationEditor.revert")(function* (number, input) {
          yield* Effect.annotateCurrentSpan({ revision: number, expectedRevision: input.expected });
          const snapshot = yield* snapshotFor(input.expected);
          const target = yield* revision(number);
          const history = yield* store.list(Option.none());
          const changes = yield* revertConfiguration(parser, target, history, snapshot).pipe(
            Effect.tapError((error) =>
              Effect.logInfo("Configuration revert refused", {
                revision: number,
                errorTag: error._tag,
              }),
            ),
          );
          return yield* save(snapshot, input, changes);
        }),
      });
    }),
  );
}
