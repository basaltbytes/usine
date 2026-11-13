import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { type BillingPool, PoolLogin } from "@usine/core/agent/session";
import { Effect, Option, Schema } from "effect";
import { PoolUnavailableError } from "../../runtime.ts";
import {
  AccountResponse,
  type GetAccountParams,
  type InitializeParams,
} from "../../protocol/codex/codex.ts";
import type { CodexConnection } from "./app-server.ts";

/**
 * Sends `initialize` and `initialized` to the app server; must run before account checks or
 * creating a child. `experimentalApi` opts the connection into experimental request fields, which
 * a thread that registers usine tools needs.
 */
export const initializeCodex = Effect.fn("Codex.initialize")(function* (
  connection: CodexConnection,
  options: { readonly experimentalApi: boolean } = { experimentalApi: false },
) {
  const params = {
    clientInfo: { name: "usine", title: "usine", version: "0.0.1" },
    capabilities: options.experimentalApi
      ? { experimentalApi: true, requestAttestation: false }
      : null,
  } satisfies InitializeParams;
  yield* connection.request("launch", "initialize", params).pipe(
    Effect.catchTag("SessionOperationError", (error) =>
      Schema.is(
        Schema.Struct({
          code: Schema.Literal(-32600),
          message: Schema.Literal("Already initialized"),
        }),
      )(error.cause)
        ? Effect.logDebug("Attached to an initialized Codex app-server")
        : Effect.fail(error),
    ),
  );
  yield* connection.notify("launch", "initialized", {});
});

/** Returns the error for when Codex cannot confirm a supported billing pool. */
export const codexPoolUnavailable = (model: ModelId) =>
  PoolUnavailableError.make({
    harness: Harness.make("codex"),
    model,
    pool: "chatgptPlan",
    message:
      "Codex children need a ChatGPT login or API key. Connect ChatGPT in usine or run codex login on the worker.",
  });

/** Verifies the Codex account before any model request. Fails with `PoolUnavailableError` for unknown or missing authentication (ADR 0013). */
export const verifyCodexAccount = Effect.fn("Codex.verifyAccount")(function* (
  connection: CodexConnection,
  model: ModelId,
) {
  yield* Effect.annotateCurrentSpan({ harness: Harness.make("codex"), model });
  const params = { refreshToken: false } satisfies GetAccountParams;
  const response = yield* connection.request("launch", "account/read", params);
  const account = yield* Schema.decodeUnknownEffect(AccountResponse)(response).pipe(
    Effect.tapError(() =>
      Effect.logError("Codex returned an unrecognized account status", { model }),
    ),
    // An auth response that does not decode is treated as an unsupported billing pool.
    Effect.mapError(() => codexPoolUnavailable(model)),
  );
  if (
    (account.account?.type !== "chatgpt" && account.account?.type !== "apiKey") ||
    !account.requiresOpenaiAuth
  ) {
    yield* Effect.logError("Codex rejected an unavailable billing pool", {
      model,
      authentication: account.account?.type ?? "logged-out",
    });
    return yield* codexPoolUnavailable(model);
  }
  const pool: BillingPool = account.account.type === "apiKey" ? "apiKeys" : "chatgptPlan";
  yield* Effect.logInfo("Codex billing pool verified", {
    model,
    authentication: account.account.type,
    pool,
  });
  return {
    pool,
    login: Option.fromNullishOr(
      account.account.type === "chatgpt" ? account.account.email : null,
    ).pipe(Option.flatMap(Schema.decodeUnknownOption(PoolLogin))),
  };
});

/**
 * Returns a Codex child's billing pool and login. `routePool` is the pool that the credential route
 * determined at admission: a gateway credential, with which Codex has no login of its own
 * (ADR 0027). Without it, Codex reports the pool of its login.
 */
export const codexChildAccount = Effect.fn("Codex.childAccount")(function* (
  connection: CodexConnection,
  brain: BrainSpec,
  routePool: Option.Option<BillingPool>,
) {
  if (Option.isNone(routePool)) return yield* verifyCodexAccount(connection, brain.model);
  const pool = routePool.value;
  yield* Effect.logInfo("Codex uses the Gateway's OpenAI credential; skipped the login check", {
    model: brain.model,
    pool,
  });
  return { pool, login: Option.none<PoolLogin>() };
});
