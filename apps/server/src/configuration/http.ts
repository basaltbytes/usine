import {
  type ConfigurationRevision,
  ConfigurationEntityId,
  ConfigurationEntityKey,
  ConfigurationEntityKind,
} from "@usine/config/configuration";
import { ConfigurationEditor, type ConfigurationEditorError } from "@usine/orchestrator/operator";
import {
  ConfigurationInvalidRefusal,
  ConfigurationRevisionView,
  ConfigurationRevertRefusal,
  OperatorHttpError,
  StaleRevisionRefusal,
  reloadRefusal,
} from "@usine/orchestrator/operator/http";
import { Array as Arr, Effect, Option, Schema } from "effect";

const problemEntity = (file: string) => {
  const colon = file.indexOf(":");
  const slash = file.indexOf("/");
  const kind = colon >= 0 ? file.slice(0, colon) : file.slice(0, slash).replace(/s$/u, "");
  const identifier =
    colon >= 0 ? file.slice(colon + 1) : file.slice(slash + 1).replace(/\.md$/u, "");
  return new ConfigurationEntityKey({
    kind: Option.getOrElse(
      Schema.decodeUnknownOption(ConfigurationEntityKind)(kind),
      () => "settings" as const,
    ),
    identifier: ConfigurationEntityId.make(file === "usine.yaml" ? "instance" : identifier),
  });
};

const refusal = (error: ConfigurationEditorError) => {
  switch (error._tag) {
    case "StaleRevision":
      return new StaleRevisionRefusal({
        error: error._tag,
        message: "The configuration changed. Read it again before saving.",
        expected: error.expected,
        current: error.actual,
      });
    case "ConfigurationInvalid": {
      const problems = error.problems.flatMap((problem) => {
        const entity = problemEntity(problem.file);
        return (problem.details ?? [{ path: [], message: problem.message }]).map((detail) => ({
          entity,
          ...detail,
        }));
      });
      return new ConfigurationInvalidRefusal({
        error: error._tag,
        message: "The configuration is invalid.",
        problems: Arr.isArrayNonEmpty(problems)
          ? problems
          : [
              {
                entity: problemEntity("usine.yaml"),
                path: [],
                message: "The configuration is invalid.",
              },
            ],
      });
    }
    case "ConfigurationRevertBlocked":
      return new ConfigurationRevertRefusal({
        error: error._tag,
        message: "Later revisions changed these entities.",
        entities: error.entities,
      });
    case "ConfigurationNotFound":
      return new OperatorHttpError({ error: error._tag, message: error.message });
    case "ConfigurationStoreError":
      return new OperatorHttpError({ error: error._tag, message: `Could not ${error.operation}.` });
    default:
      return reloadRefusal(error, error.message);
  }
};

export const fromConfiguration = <A>(
  use: (editor: ConfigurationEditor["Service"]) => Effect.Effect<A, ConfigurationEditorError>,
) =>
  Effect.gen(function* () {
    const editor = yield* Effect.serviceOption(ConfigurationEditor);
    if (Option.isNone(editor))
      return yield* new OperatorHttpError({
        error: "BackendUnavailableError",
        message: "Configuration editing is unavailable.",
      });
    return yield* use(editor.value).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Configuration request failed", { errorTag: error._tag }),
      ),
      Effect.mapError(refusal),
    );
  });

export const fromConfigurationRevision = (
  use: (
    editor: ConfigurationEditor["Service"],
  ) => Effect.Effect<ConfigurationRevision, ConfigurationEditorError>,
) => fromConfiguration(use).pipe(Effect.map(ConfigurationRevisionView.fromRevision));
