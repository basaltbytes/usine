import { Harness } from "@usine/core/agent/brain";
import { Effect, Option, Schema } from "effect";
import { ModelListParams, ModelListResponse } from "../../protocol/codex/codex.ts";
import { UnknownModelError, UnsupportedEffortError } from "../../runtime.ts";
import type { SessionSpec } from "../contract.ts";
import type { CodexClient, CodexConnection } from "./app-server.ts";
import { decodeResponse } from "./codec.ts";

/**
 * Checks the brain of `spec` against the app server's model catalog. Returns the reasoning effort
 * to send for the model, and fails for a model or effort that Codex doesn't offer. `cliVersion` is
 * the version that `initializeCodex` returned; the unknown-model error names it.
 */
export const checkCodexModel = Effect.fn("Codex.checkModel")(function* (
  connection: CodexConnection,
  client: CodexClient,
  spec: SessionSpec,
  cliVersion: Option.Option<string>,
) {
  const models: Array<(typeof ModelListResponse.Type.data)[number]> = [];
  let cursor: string | null = null;
  do {
    const params: ModelListParams = { cursor, includeHidden: true, limit: 100 };
    const encodedModelListParams = yield* Schema.encodeEffect(Schema.toCodecJson(ModelListParams))(
      params,
    ).pipe(Effect.orDie);
    const response = yield* connection.request("launch", "model/list", encodedModelListParams);
    const page = yield* decodeResponse(ModelListResponse, "launch", client, "model list", response);
    models.push(...page.data);
    cursor = page.nextCursor ?? null;
  } while (cursor !== null);
  const requestedModel = spec.session.brain.model;
  const catalogModel = models.find(
    (model) => model.id === requestedModel || model.model === requestedModel,
  );
  if (catalogModel === undefined) {
    const offered = models.map(({ id }) => id);
    yield* Effect.logError("Codex rejected an unknown model", {
      model: requestedModel,
      offered,
      cliVersion: Option.getOrNull(cliVersion),
    });
    const release = Option.match(cliVersion, {
      onNone: () => "Codex CLI (version unreported)",
      onSome: (version) => `Codex CLI ${version}`,
    });
    return yield* UnknownModelError.make({
      harness: Harness.make("codex"),
      model: requestedModel,
      message: `${release} has no model "${requestedModel}". Offered models: ${offered.length > 0 ? offered.join(", ") : "none"}.`,
    });
  }
  const effort = spec.session.brain.effort === "off" ? "none" : spec.session.brain.effort;
  const supportedEfforts = catalogModel.supportedReasoningEfforts;
  if (
    supportedEfforts !== undefined &&
    supportedEfforts.length > 0 &&
    !supportedEfforts.some((option) => option.reasoningEffort === effort)
  ) {
    yield* Effect.logError("Codex rejected an unsupported effort", {
      effort: spec.session.brain.effort,
      model: requestedModel,
      supported: supportedEfforts.map((option) => option.reasoningEffort),
    });
    return yield* UnsupportedEffortError.make({
      harness: Harness.make("codex"),
      model: requestedModel,
      effort: spec.session.brain.effort,
      message: `Codex model "${requestedModel}" doesn't support effort ${effort}`,
    });
  }
  return effort;
});
