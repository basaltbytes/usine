import { InstanceDirectory } from "@usine/core/instance";
import { loginLlmProvider, ProviderLoginView, ProviderStatus } from "@usine/gateway/credentials";
import { Console, Effect, Option, Redacted, Schema } from "effect";
import { Prompt } from "effect/cli";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { instanceFiles, readRecord } from "../instance/record.ts";
import { readAdminToken } from "../auth/local.ts";
import { authFailure } from "../auth/model.ts";
import type { ProviderCommand } from "../cli.ts";

export const providerCommand = Effect.fn("Cli.providerLogin")(function* (
  directory: InstanceDirectory,
  command: ProviderCommand,
) {
  const record = yield* readRecord(instanceFiles(directory)).pipe(
    Effect.mapError(() =>
      authFailure("Could not read the instance record. Start usine up first.", 503),
    ),
  );
  if (Option.isNone(record))
    return yield* authFailure("Start usine up before connecting a provider.", 503);
  const origin = `http://127.0.0.1:${record.value.launch.port}`;
  const token = yield* readAdminToken(directory);
  const http = yield* HttpClient.HttpClient;
  const client = HttpClient.filterStatusOk(http);
  const request = <A, I>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    schema: Schema.Codec<A, I>,
    body?: Readonly<Record<string, string>>,
  ) => {
    const outgoing = HttpClientRequest.make(method)(`${origin}${path}`).pipe(
      HttpClientRequest.bearerToken(token),
    );
    return client
      .execute(body === undefined ? outgoing : HttpClientRequest.bodyJsonUnsafe(outgoing, body))
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.timeout("45 seconds"),
        Effect.mapError(() =>
          authFailure(
            "Provider connection failed. Check the instance and gateway service logs, then try again.",
            503,
          ),
        ),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      );
  };
  const status = yield* request("GET", "/api/providers", ProviderStatus);
  const targetName = Option.getOrNull(command.target);
  const targets =
    targetName === null
      ? status.targets
      : status.targets.filter(({ target }) => target === targetName);
  const target = targets[0];
  if (targets.length !== 1 || target === undefined)
    return yield* authFailure(
      "Choose one destination with --target <gateway SSH destination>. Run this command once for each gateway.",
      400,
    );
  if ("error" in target) return yield* authFailure(`${target.label}: ${target.error}`, 503);
  const connection = target.providers.find(
    ({ provider }) => provider === loginLlmProvider(command.provider),
  );
  if (connection !== undefined && "error" in connection)
    return yield* authFailure(`${target.label}: ${connection.error}`, 503);
  const body = { target: target.target, provider: command.provider };
  const ok = Schema.Struct({ ok: Schema.Boolean });
  if (command.action === "logout") {
    yield* request("POST", "/api/providers/disconnect", ok, body);
    return yield* Console.log(`Disconnected ${command.provider} from ${target.label}.`);
  }
  if (command.mode === "api-key") {
    const key = yield* Prompt.run(Prompt.Password({ message: "API key" })).pipe(
      Effect.mapError(() => authFailure("API key entry cancelled.", 400)),
    );
    yield* request("PUT", "/api/providers/key", ok, { ...body, key: Redacted.value(key) });
    return yield* Console.log(`Connected ${command.provider} on ${target.label}.`);
  }
  const started = yield* request("POST", "/api/providers/login", ProviderLoginView, body);
  const cancel = request("DELETE", `/api/providers/login/${started.id}`, ok).pipe(
    Effect.tapError(() =>
      Effect.logWarning("Could not cancel the provider login", { loginId: started.id }),
    ),
    Effect.ignore,
  );
  yield* Effect.gen(function* () {
    let prompted = false;
    while (true) {
      const current = yield* request("GET", "/api/providers", ProviderStatus);
      const login = current.logins.find(({ id }) => id === started.id);
      if (login === undefined)
        return yield* authFailure("The login ended. Try connecting again.", 503);
      const state = login.state;
      if (state.status === "connected")
        return yield* Console.log(`Connected ${command.provider} on ${target.label}.`);
      if (state.status === "failed") return yield* authFailure(state.message, 503);
      if (state.status === "cancelled")
        return yield* authFailure("Provider sign-in cancelled.", 400);
      if (state.status === "authorizing" && !prompted) {
        prompted = true;
        yield* Console.log(
          `Open ${state.url}${state.code === null ? "." : ` and enter ${state.code}.`}`,
        );
        if (command.provider === "claude") {
          yield* Console.log("Paste the code from Claude, then press Enter:");
          const code = yield* Prompt.run(
            Prompt.Password({ message: "Claude authorization code" }),
          ).pipe(Effect.mapError(() => authFailure("Code entry cancelled.", 400)));
          yield* request("POST", "/api/providers/code", ok, {
            id: started.id,
            code: Redacted.value(code),
          });
        }
      }
      yield* Effect.sleep("2 seconds");
    }
  }).pipe(
    Effect.onInterrupt(() => cancel),
    Effect.onError(() => cancel),
  );
});
