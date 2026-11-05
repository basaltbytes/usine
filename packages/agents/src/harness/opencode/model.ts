import type { BrainSpec } from "@usine/core/agent/brain";
import { Effect, Option, Schema } from "effect";
import { PoolUnavailableError, UnknownModelError, UnsupportedEffortError } from "../../runtime.ts";
import { Integrations, Models } from "./codec.ts";
import { type OpenCodeClient, type OpenCodeConnection, operationError } from "./server.ts";

export const modelRoute = Effect.fn("OpenCode.modelRoute")(function* (
  brain: BrainSpec,
  client: OpenCodeClient,
  connection: OpenCodeConnection,
  gateway: Option.Option<"subscription" | "api-key">,
) {
  yield* Effect.annotateCurrentSpan({
    sessionId: Option.getOrUndefined(client.sessionId),
    harness: brain.harness,
    model: brain.model,
  });
  const decodeModels = yield* connection.request(
    "launch",
    "GET",
    `/api/model?directory=${encodeURIComponent(client.cwd)}`,
  );
  const { data: models } = yield* Schema.decodeUnknownEffect(Models)(decodeModels).pipe(
    Effect.mapError((cause) =>
      operationError(client, "launch", "Invalid OpenCode model list", cause),
    ),
  );
  const model = models.find(
    (model) => `${model.providerID}/${model.id}` === brain.model && model.enabled,
  );
  if (model === undefined)
    return yield* UnknownModelError.make({
      harness: brain.harness,
      model: brain.model,
      message: `OpenCode has no enabled model "${brain.model}". Use provider/model and configure its credential on the worker.`,
    });
  const variant = brain.effort === "off" ? {} : { variant: brain.effort };
  if (brain.effort !== "off" && !model.variants.some(({ id }) => id === brain.effort))
    return yield* UnsupportedEffortError.make({
      harness: brain.harness,
      model: brain.model,
      effort: brain.effort,
      message: `OpenCode model "${brain.model}" doesn't support effort ${brain.effort}`,
    });
  const raw = yield* connection.request(
    "launch",
    "GET",
    `/api/integration?directory=${encodeURIComponent(client.cwd)}`,
  );
  const integrations = yield* Schema.decodeUnknownEffect(Integrations)(raw).pipe(
    Effect.mapError((cause) =>
      operationError(client, "launch", "Invalid OpenCode integrations", cause),
    ),
  );
  const active = integrations.data.find(({ id }) => id === model.providerID)?.connections[0];
  const oauth = active?.type === "credential" && active.method === "oauth";
  if ((oauth && model.providerID !== "openai") || model.providerID === "claude-agent")
    return yield* PoolUnavailableError.make({
      harness: brain.harness,
      model: brain.model,
      pool:
        model.providerID === "anthropic" || model.providerID === "claude-agent"
          ? "claudePlan"
          : "apiKeys",
      message:
        "OpenCode supports subscription billing only through an OpenAI ChatGPT login. Use Claude Code for Claude subscriptions.",
    });
  if (Option.isSome(gateway) && model.providerID !== "openai")
    return yield* PoolUnavailableError.make({
      harness: brain.harness,
      model: brain.model,
      pool: "apiKeys",
      message: "The OpenCode gateway route requires an openai/model model",
    });
  const pool = (
    Option.isSome(gateway)
      ? gateway.value === "subscription"
      : oauth && model.providerID === "openai"
  )
    ? ("chatgptPlan" as const)
    : ("apiKeys" as const);
  yield* Effect.logInfo("OpenCode model route verified", {
    model: brain.model,
    pool,
    provider: model.providerID,
  });
  return { model: { providerID: model.providerID, id: model.id, ...variant }, pool };
});
