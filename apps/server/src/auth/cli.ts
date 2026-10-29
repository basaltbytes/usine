import { instanceFiles, readRecord } from "../instance/record.ts";
import type { InstanceDirectory } from "@usine/core/instance";
import { Clock, Console, Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { SignInCommand } from "../cli.ts";
import { AuthError, authFailure } from "./model.ts";
import { readAdminToken } from "./local.ts";

export const signIn = Effect.fn("Cli.signIn")(function* (
  directory: InstanceDirectory,
  command: SignInCommand,
) {
  const record =
    command.action === "link"
      ? yield* readRecord(instanceFiles(directory)).pipe(
          Effect.mapError(() =>
            authFailure("Could not read the running instance record. Restart usine up.", 503),
          ),
        )
      : Option.none();
  const origin = Option.match(record, {
    onNone: () => command.origin,
    onSome: ({ launch }) => `http://127.0.0.1:${launch.port}`,
  });
  const client = yield* HttpClient.HttpClient;
  const request = <A, I>(
    path: string,
    payload: Readonly<Record<string, string>>,
    schema: Schema.Codec<A, I>,
    token?: Redacted.Redacted<string>,
  ) =>
    client
      .execute(
        HttpClientRequest.post(`${origin}${path}`).pipe(
          HttpClientRequest.bodyJsonUnsafe(payload),
          HttpClientRequest.setHeaders(
            token === undefined ? {} : { authorization: `Bearer ${Redacted.value(token)}` },
          ),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.status === 429
            ? Effect.fail(authFailure("Wait before checking device sign-in again.", 429))
            : response.status >= 400
              ? HttpClientResponse.schemaBodyJson(Schema.Struct({ message: Schema.String }))(
                  response,
                ).pipe(Effect.flatMap(({ message }) => authFailure(message, 403)))
              : HttpClientResponse.schemaBodyJson(schema)(response),
        ),
        Effect.timeout("20 seconds"),
        Effect.mapError((error) =>
          error instanceof AuthError
            ? error
            : authFailure(
                "Sign-in failed. Check the instance URL and GitHub App user authorization settings.",
                503,
              ),
        ),
      );
  if (command.action === "link") {
    const token = yield* readAdminToken(directory);
    const { url } = yield* request(
      "/api/auth/link",
      {},
      Schema.Struct({ url: Schema.String }),
      token,
    );
    return yield* Console.log(url);
  }
  const started = yield* request(
    "/api/auth/device",
    { name: "usine CLI" },
    Schema.Struct({
      id: Schema.String,
      userCode: Schema.String,
      verificationUri: Schema.String,
      interval: Schema.Number,
    }),
  );
  yield* Console.log(`Open ${started.verificationUri} and enter ${started.userCode}.`);
  const deadline = (yield* Clock.currentTimeMillis) + 15 * 60_000;
  let interval = started.interval;
  while ((yield* Clock.currentTimeMillis) < deadline) {
    yield* Effect.sleep(`${interval} seconds`);
    const response = yield* request(
      "/api/auth/device/poll",
      { id: started.id },
      Schema.Union([
        Schema.Struct({ pending: Schema.Literal(true) }),
        Schema.Struct({ token: Schema.String }),
      ]),
    ).pipe(
      Effect.catchTag("AuthError", (error) => {
        if (error.status !== 429) return Effect.fail(error);
        interval += 5;
        return Effect.logInfo("GitHub device polling slowed", { interval }).pipe(
          Effect.as({ pending: true } as const),
        );
      }),
    );
    if ("pending" in response) continue;
    yield* Console.log(
      `Instance token (shown once):\n${response.token}\nSend it as Authorization: Bearer <token>.`,
    );
    return;
  }
  return yield* authFailure("Device sign-in expired. Run usine sign-in again.", 401);
});
