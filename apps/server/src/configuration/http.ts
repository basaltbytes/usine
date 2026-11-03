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
  const separator = colon >= 0 && (slash < 0 || colon < slash) ? colon : slash;
  const prefix = file.slice(0, separator);
  const markdown = prefix === "agents" || prefix === "loops";
  const kind = markdown ? prefix.slice(0, -1) : prefix;
  const identifier = markdown
    ? file.slice(separator + 1).replace(/\.md$/u, "")
    : file.slice(separator + 1);
  return ConfigurationEntityKey.make({
    kind: Option.getOrElse(
      Schema.decodeUnknownOption(ConfigurationEntityKind)(kind),
      () => "settings" as const,
    ),
    identifier: ConfigurationEntityId.make(file === "usine.yaml" ? "instance" : identifier),
  });
};

const refusal = (error: ConfigurationEditorError) => {
  switch (error._tag) {
    case "AccessDenied":
      return OperatorHttpError.make({
        error: "AccessDenied",
        message: "You do not have permission for this configuration entity.",
      });
    case "StaleRevision":
      return StaleRevisionRefusal.make({
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
      return ConfigurationInvalidRefusal.make({
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
      return ConfigurationRevertRefusal.make({
        error: error._tag,
        message: "Later revisions changed these entities.",
        entities: error.entities,
      });
    case "ConfigurationNotFound":
      return OperatorHttpError.make({ error: error._tag, message: error.message });
    case "ConfigurationStoreError":
      return OperatorHttpError.make({
        error: error._tag,
        message: `Could not ${error.operation}.`,
      });
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
      return yield* OperatorHttpError.make({
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
