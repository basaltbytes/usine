import {
  Cause,
  Context,
  Crypto,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Redacted,
  Schedule,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { createServer } from "node:net";
import { childPidFile, type ChildHost } from "../../child-host/child-host.ts";
import { hostCommand } from "../../child-host/command.ts";
import { SessionOperationError, type WorkingDirectory } from "../../runtime.ts";
import type { AgentSessionId } from "@usine/core/agent/session";

export interface OpenCodeClient {
  readonly cwd: WorkingDirectory;
  readonly sessionId: Option.Option<AgentSessionId>;
  readonly environment: Readonly<Record<string, string>>;
  readonly host: ChildHost;
}

export interface OpenCodeConnection {
  readonly request: (
    operation: SessionOperationError["operation"],
    method: "GET" | "POST",
    path: string,
    body?: Schema.Json,
  ) => Effect.Effect<Schema.Json, SessionOperationError>;
  readonly events: Stream.Stream<Schema.Json, SessionOperationError>;
  readonly close: Effect.Effect<void, SessionOperationError>;
}

export class OpenCodeServer extends Context.Service<
  OpenCodeServer,
  {
    readonly open: (
      client: OpenCodeClient,
    ) => Effect.Effect<OpenCodeConnection, SessionOperationError, Scope.Scope>;
  }
>()("@usine/agents/harness/opencode/server/OpenCodeServer") {}

export const operationError = (
  client: OpenCodeClient,
  operation: SessionOperationError["operation"],
  message: string,
  cause: unknown,
) => SessionOperationError.make({ operation, sessionId: client.sessionId, message, cause });

const Config = Schema.Record(Schema.String, Schema.Json);
const Ready = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^http:\/\/127\.0\.0\.1:\d+$/u)),
});
const PortAddress = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

const availablePort = (client: OpenCodeClient) =>
  Effect.callback<number, SessionOperationError>((resume) => {
    const socket = createServer();
    socket.once("error", (cause) =>
      resume(
        Effect.fail(
          operationError(client, "launch", "Can't allocate an OpenCode SSH forward", cause),
        ),
      ),
    );
    socket.listen(0, "127.0.0.1", () => {
      const address = Schema.decodeUnknownOption(PortAddress)(socket.address());
      if (Option.isNone(address)) {
        socket.close();
        resume(
          Effect.fail(
            operationError(
              client,
              "launch",
              "No OpenCode forwarding port",
              new Error("missing port"),
            ),
          ),
        );
      } else
        socket.close((cause) =>
          resume(
            cause !== undefined
              ? Effect.fail(
                  operationError(client, "launch", "Can't release the forwarding port", cause),
                )
              : Effect.succeed(address.value.port),
          ),
        );
    });
    return Effect.sync(() => {
      if (socket.listening) socket.close();
    });
  });

const makeServer = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const clientHttp = yield* HttpClient.HttpClient;
  const http = HttpClient.filterStatusOk(clientHttp);
  const crypto = yield* Crypto.Crypto;
  const open: OpenCodeServer["Service"]["open"] = Effect.fn("OpenCodeServer.open")(
    function* (client) {
      yield* Effect.annotateCurrentSpan({
        sessionId: Option.getOrUndefined(client.sessionId),
        host: client.host._tag,
      });
      const config = yield* Schema.decodeEffect(Schema.fromJsonString(Config))(
        client.environment.OPENCODE_CONFIG_CONTENT ?? "{}",
      ).pipe(
        Effect.mapError((cause) =>
          operationError(client, "launch", "Invalid OpenCode configuration", cause),
        ),
      );
      const passwordValue = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const password = Redacted.make(passwordValue);
      const content = yield* Schema.encodeEffect(Schema.fromJsonString(Config))({
        ...config,
        update: "disable",
        share: "disabled",
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      }).pipe(Effect.orDie);
      const input = yield* Queue.make<Uint8Array, Cause.Done>();
      const handle = yield* spawner
        .spawn(
          hostCommand(
            client.host,
            {
              cwd: "/",
              command: "opencode",
              args: ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
              pidFile: Option.getOrUndefined(
                Option.map(client.sessionId, (id) => childPidFile(client.cwd, id)),
              ),
              environment: {
                ...client.environment,
                OPENCODE_PASSWORD: Redacted.value(password),
                OPENCODE_SERVER_PASSWORD: Redacted.value(password),
                OPENCODE_CONFIG_PROJECT_DISABLE: "1",
                OPENCODE_DISABLE_CLAUDE_CODE: "1",
                OPENCODE_DISABLE_MODELS_FETCH: "1",
                OPENCODE_CONFIG_CONTENT: content,
              },
            },
            {
              detached: false,
              forceKillAfter: "5 seconds",
              stdin: { stream: Stream.fromQueue(input), endOnDone: true },
            },
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            operationError(client, "launch", "Can't start OpenCode", cause),
          ),
        );
      const ready = yield* Deferred.make<string, SessionOperationError>();
      yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Deferred.succeed(ready, line)),
        Effect.ensuring(
          Deferred.fail(
            ready,
            operationError(
              client,
              "launch",
              "OpenCode exited before readiness",
              new Error("stdout closed"),
            ),
          ),
        ),
        Effect.catchTag("PlatformError", (cause) =>
          Deferred.fail(
            ready,
            operationError(client, "launch", "Can't read OpenCode readiness", cause),
          ),
        ),
        Effect.forkScoped,
      );
      yield* handle.stderr.pipe(
        Stream.runDrain,
        Effect.tapError((error) =>
          Effect.logWarning("OpenCode stderr closed", { errorTag: error._tag }),
        ),
        Effect.ignore,
        Effect.forkScoped,
      );
      const line = yield* Deferred.await(ready).pipe(
        Effect.timeout("60 seconds"),
        Effect.mapError((cause) =>
          operationError(client, "launch", "OpenCode readiness failed", cause),
        ),
      );
      const { url } = yield* Schema.decodeEffect(Schema.fromJsonString(Ready))(line).pipe(
        Effect.mapError((cause) =>
          operationError(client, "launch", "Invalid OpenCode readiness", cause),
        ),
      );
      let baseUrl = url;
      if (client.host._tag === "RemoteShell") {
        const port = yield* availablePort(client);
        const remotePort = new URL(url).port;
        yield* spawner
          .spawn(
            ChildProcess.make(
              client.host.ssh.command,
              [
                ...client.host.ssh.args,
                "-N",
                "-o",
                "ExitOnForwardFailure=yes",
                "-L",
                `127.0.0.1:${port}:127.0.0.1:${remotePort}`,
                client.host.destination,
              ],
              {
                env: { ...client.host.sshEnvironment },
                extendEnv: false,
                detached: false,
                forceKillAfter: "2 seconds",
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              },
            ),
          )
          .pipe(
            Effect.mapError((cause) =>
              operationError(client, "launch", "Can't start the OpenCode SSH forward", cause),
            ),
          );
        baseUrl = `http://127.0.0.1:${port}`;
        yield* Effect.logInfo("OpenCode SSH forward started", {
          sessionId: Option.getOrUndefined(client.sessionId),
          destination: client.host.destination,
        });
      }
      const request: OpenCodeConnection["request"] = Effect.fn("OpenCodeServer.request")(
        function* (operation, method, path, body) {
          yield* Effect.annotateCurrentSpan({
            operation,
            method,
            sessionId: Option.getOrUndefined(client.sessionId),
          });
          const base = HttpClientRequest.make(method)(`${baseUrl}${path}`).pipe(
            HttpClientRequest.basicAuth("opencode", password),
          );
          const req =
            body === undefined
              ? base
              : yield* HttpClientRequest.schemaBodyJson(Schema.Json)(body)(base).pipe(
                  Effect.mapError((cause) =>
                    operationError(client, operation, "Can't encode OpenCode request", cause),
                  ),
                );
          return yield* http.execute(req).pipe(
            Effect.flatMap((response) =>
              response.status === 204 ? Effect.succeed(null) : response.json,
            ),
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) =>
              operationError(client, operation, "OpenCode request failed", cause),
            ),
          );
        },
      );
      yield* request(
        "launch",
        "GET",
        `/api/config?directory=${encodeURIComponent(client.cwd)}`,
      ).pipe(
        Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
        Effect.timeout("10 seconds"),
        Effect.mapError((cause) =>
          operationError(client, "launch", "OpenCode server did not become reachable", cause),
        ),
      );
      const events = Stream.unwrap(
        http
          .execute(
            HttpClientRequest.get(`${baseUrl}/api/event`).pipe(
              HttpClientRequest.basicAuth("opencode", password),
            ),
          )
          .pipe(Effect.map((response) => response.stream)),
      ).pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.startsWith("data:")),
        Stream.mapEffect((line) => decodeJson(line.slice(5).trim())),
        Stream.mapError((cause) =>
          operationError(client, "stream", "OpenCode event stream failed", cause),
        ),
      );
      const close = Effect.gen(function* () {
        yield* Queue.end(input);
        yield* handle.exitCode.pipe(
          Effect.timeout("10 seconds"),
          Effect.mapError((cause) =>
            operationError(client, "interrupt", "OpenCode did not stop", cause),
          ),
        );
      });
      return { request, events, close } satisfies OpenCodeConnection;
    },
  );
  return OpenCodeServer.of({ open });
});

export const openCodeServerLive = Layer.effect(OpenCodeServer, makeServer).pipe(
  Layer.provide(FetchHttpClient.layer),
);
