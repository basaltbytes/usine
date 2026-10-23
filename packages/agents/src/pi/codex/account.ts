import type { ModelId } from "@usine/core/agent/brain";
import { Effect, Schema } from "effect";
import { PoolUnavailableError } from "../../runtime.ts";
import {
  AccountResponse,
  type GetAccountParams,
  type InitializeParams,
} from "../../protocol/codex.ts";
import type { CodexConnection } from "./app-server.ts";

/** Sends `initialize` and `initialized` to the app server; must run before account checks or creating a child. */
export const initializeCodex = Effect.fn("Codex.initialize")(function* (
  connection: CodexConnection,
) {
  const params: InitializeParams = {
    clientInfo: { name: "usine", title: "usine", version: "0.0.1" },
    capabilities: null,
  };
  yield* connection.request("launch", "initialize", Schema.decodeUnknownSync(Schema.Json)(params));
  yield* connection.notify("launch", "initialized", {});
});

/** Returns the error for when Codex cannot confirm that it uses the ChatGPT pool. */
export const codexPoolUnavailable = (model: ModelId) =>
  new PoolUnavailableError({
    harness: "codex",
    model,
    pool: "chatgptPlan",
    message: "Codex children require a ChatGPT login; run codex login on the Worker",
  });

/** Verifies the Codex account before any model request. Fails with `PoolUnavailableError` for unknown, missing, or API-key authentication (ADR 0013). */
export const verifyCodexAccount = Effect.fn("Codex.verifyAccount")(function* (
  connection: CodexConnection,
  model: ModelId,
) {
  yield* Effect.annotateCurrentSpan({ harness: "codex", model });
  const params: GetAccountParams = { refreshToken: false };
  const response = yield* connection.request(
    "launch",
    "account/read",
    Schema.decodeUnknownSync(Schema.Json)(params),
  );
  const account = yield* Schema.decodeUnknownEffect(AccountResponse)(response).pipe(
    Effect.tapError(() =>
      Effect.logError("Codex returned an unrecognized account status", { model }),
    ),
    // An auth response that does not decode is treated as an unsupported billing pool.
    Effect.mapError(() => codexPoolUnavailable(model)),
  );
  if (account.account?.type !== "chatgpt" || !account.requiresOpenaiAuth) {
    yield* Effect.logError("Codex rejected an unavailable billing pool", {
      model,
      requiredPool: "chatgptPlan",
      authentication: account.account?.type ?? "logged-out",
    });
    return yield* codexPoolUnavailable(model);
  }
  yield* Effect.logInfo("Codex billing pool verified", {
    model,
    authentication: account.account.type,
    pool: "chatgptPlan",
  });
  return "chatgptPlan" as const;
});
