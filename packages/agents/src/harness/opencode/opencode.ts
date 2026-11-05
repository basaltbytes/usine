import {
  ChildSession,
  EndpointName,
  HarnessSession,
  HarnessSessionId,
  ProviderRecovered,
  ProviderRetries,
  ProviderRetrying,
  SessionStarted,
  SessionTokensUpdated,
  TextOutput,
  TokenBreakdown,
  TokenCount,
  ToolFinished,
  ToolStarted,
  UsdAmount,
} from "@usine/core/agent/session";
import { Crypto, Deferred, Effect, Layer, Option, Schema, Stream } from "effect";
import { Steer } from "@usine/core/attempt/channel";
import {
  AgentResultError,
  ChildBackend,
  harnessFailure,
  type RunningSession,
} from "../../runtime.ts";
import { HarnessCatalog } from "../harness.ts";
import { admitChild } from "../launch.ts";
import { sessionChannel } from "../session.ts";
import { sessionConversation } from "../conversation.ts";
import type { HarnessRuntime } from "../runtime.ts";
import { EventHeader, OpenCodeEvent, SessionCreated } from "./codec.ts";
import { opencode } from "./descriptor.ts";
import { modelRoute } from "./model.ts";
import { openCodePreflight } from "./preflight.ts";
import { OpenCodeServer, type OpenCodeClient, operationError } from "./server.ts";

export {
  OpenCodeServer,
  openCodeServerLive,
  type OpenCodeClient,
  type OpenCodeConnection,
} from "./server.ts";

const ownCatalog = HarnessCatalog.make({ descriptors: [opencode] });
const eventTypes: ReadonlySet<string> = new Set(
  OpenCodeEvent.members.map((schema) => schema.fields.type.literal),
);

const makeChild = Effect.gen(function* () {
  const server = yield* OpenCodeServer;
  const crypto = yield* Crypto.Crypto;
  const launch: ChildBackend["Service"]["launch"] = Effect.fn("OpenCodeRuntime.launch")(
    function* (request) {
      const { brain } = request.session;
      yield* Effect.annotateCurrentSpan({
        sessionId: request.session.id,
        worker: request.worker,
        harness: brain.harness,
        model: brain.model,
      });
      yield* admitChild(ownCatalog, request);
      const client: OpenCodeClient = {
        cwd: request.cwd,
        sessionId: Option.some(request.session.id),
        host: request.host,
        environment: request.environment,
      };
      const connection = yield* server.open(client);
      const route = yield* modelRoute(brain, client, connection, request.session.gatewayCredential);
      const created = yield* connection.request("launch", "POST", "/api/session", {
        location: { directory: request.cwd },
        model: route.model,
        title: `usine ${request.session.id}`,
      });
      const { data: saved } = yield* Schema.decodeUnknownEffect(SessionCreated)(created).pipe(
        Effect.mapError((cause) =>
          operationError(client, "launch", "Invalid OpenCode session", cause),
        ),
      );
      const path = `/api/session/${encodeURIComponent(saved.id)}`;
      const session = ChildSession.make({
        ...request.session,
        pool: Option.some(route.pool),
        endpoint:
          route.pool === "apiKeys"
            ? Option.some(EndpointName.make(route.model.providerID))
            : Option.none(),
      });
      const channel = yield* sessionChannel({ label: "OpenCode child", sessionId: session.id });
      const connected = yield* Deferred.make<void>();
      let stopped = yield* Deferred.make<void>();
      const sent = new Map<string, string>();
      const delivered = new Set<string>();
      const tools = new Map<string, string>();
      let lastText = "";
      let assistantMessage: string | undefined;
      let retries = 0;
      let canceling = false;
      let closing = false;
      let active = false;
      let interruption: "none" | "pending" | "resuming" = "none";
      let total = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: 0 };
      const pause = Effect.gen(function* () {
        interruption = active ? "pending" : "none";
        yield* connection.request("interrupt", "POST", `${path}/interrupt`);
      });
      const conversation = yield* sessionConversation({
        session,
        channel,
        send: Effect.fn("OpenCodeRuntime.send")(function* (message, activity) {
          const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
          const id = `msg_usine_${uuid.replaceAll("-", "")}`;
          if (!active) {
            stopped = yield* Deferred.make<void>();
          }
          if (!active || interruption !== "none") {
            lastText = "";
            assistantMessage = undefined;
          }
          if (activity === "running") sent.set(id, message);
          active = true;
          if (interruption !== "none") interruption = "resuming";
          yield* connection.request("steer", "POST", `${path}/prompt`, {
            id,
            text: message,
            delivery: "steer",
          });
          return activity === "running" ? "queued" : "read";
        }),
        pause,
        beforeFinish: Effect.gen(function* () {
          closing = true;
          yield* connection.close;
        }),
      });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closing = true;
          if (active)
            yield* pause.pipe(
              Effect.timeout("10 seconds"),
              Effect.tapError((error) =>
                Effect.logWarning("OpenCode cleanup could not interrupt execution", {
                  sessionId: session.id,
                  errorTag: error._tag,
                }),
              ),
              Effect.ignore,
            );
          yield* connection.close.pipe(
            Effect.tapError((error) =>
              Effect.logWarning("OpenCode cleanup could not close the server", {
                sessionId: session.id,
                errorTag: error._tag,
              }),
            ),
            Effect.ignore,
          );
        }),
      );
      yield* channel.emit(
        SessionStarted.make({
          session,
          harnessSession: Option.some(
            HarnessSession.make({
              id: HarnessSessionId.make(saved.id),
              cwd: request.cwd,
              home: Option.fromUndefinedOr(request.environment.XDG_DATA_HOME),
            }),
          ),
        }),
      );
      const consume = connection.events.pipe(
        Stream.runForEach((raw) =>
          Effect.gen(function* () {
            const header = yield* Schema.decodeUnknownEffect(EventHeader)(raw).pipe(
              Effect.mapError((cause) =>
                operationError(client, "stream", "Invalid OpenCode event header", cause),
              ),
            );
            if (!eventTypes.has(header.type)) return;
            const event = yield* Schema.decodeUnknownEffect(OpenCodeEvent)(raw).pipe(
              Effect.mapError((cause) =>
                operationError(client, "stream", `Invalid OpenCode ${header.type} event`, cause),
              ),
            );
            if (event.type === "server.connected") {
              yield* Deferred.succeed(connected, undefined);
              return;
            }
            if (event.data.sessionID !== saved.id) return;
            if (
              retries > 0 &&
              ["session.text.ended", "session.tool.called", "session.step.ended"].includes(
                event.type,
              )
            ) {
              yield* channel.emit(
                ProviderRecovered.make({ session, retries: ProviderRetries.make(retries) }),
              );
              yield* Effect.logInfo("OpenCode provider recovered", {
                sessionId: session.id,
                retries,
              });
              retries = 0;
            }
            switch (event.type) {
              case "session.text.ended":
                lastText =
                  assistantMessage === event.data.assistantMessageID
                    ? lastText + event.data.text
                    : event.data.text;
                assistantMessage = event.data.assistantMessageID;
                yield* channel.emit(TextOutput.make({ session, text: event.data.text }));
                break;
              case "session.tool.input.started":
                tools.set(`${event.data.assistantMessageID}:${event.data.id}`, event.data.name);
                break;
              case "session.tool.called":
              case "session.tool.success":
              case "session.tool.failed": {
                const callId = `${event.data.assistantMessageID}:${event.data.id}`;
                const tool = tools.get(callId);
                if (tool === undefined)
                  return yield* operationError(
                    client,
                    "stream",
                    "OpenCode reported a tool without its name",
                    new Error("missing tool start"),
                  );
                if (event.type === "session.tool.called")
                  yield* channel.emit(
                    ToolStarted.make({ session, callId, tool, input: event.data.input }),
                  );
                else {
                  yield* channel.emit(
                    ToolFinished.make({
                      session,
                      callId,
                      tool,
                      output:
                        event.type === "session.tool.success"
                          ? event.data.content
                          : event.data.error.message,
                      isError: event.type === "session.tool.failed",
                    }),
                  );
                  tools.delete(callId);
                }
                break;
              }
              case "session.step.ended":
              case "session.step.failed": {
                const { tokens, cost } = event.data;
                if (tokens !== undefined && cost !== undefined) {
                  total = {
                    input: total.input + tokens.input,
                    cachedInput: total.cachedInput + tokens.cache.read,
                    cacheWrite: total.cacheWrite + tokens.cache.write,
                    output: total.output + tokens.output + tokens.reasoning,
                    cost: total.cost + cost,
                  };
                  const breakdown = TokenBreakdown.make(total);
                  yield* channel.emit(
                    SessionTokensUpdated.make({
                      session,
                      totalTokens: TokenCount.make(total.input + total.cacheWrite + total.output),
                      costUsd: Option.some(UsdAmount.make(total.cost)),
                      breakdown: Option.some(breakdown),
                    }),
                  );
                }
                break;
              }
              case "session.retry.scheduled":
                retries = event.data.attempt;
                yield* Effect.logWarning("OpenCode provider request will retry", {
                  sessionId: session.id,
                  retries,
                  errorType: event.data.error.type,
                });
                yield* channel.emit(
                  ProviderRetrying.make({
                    session,
                    message: `OpenCode provider retry: ${event.data.error.type}`,
                    retries: ProviderRetries.make(retries),
                  }),
                );
                break;
              case "session.inbox.delivered": {
                const message = sent.get(event.data.inboxID);
                if (message !== undefined) {
                  delivered.add(message);
                  sent.delete(event.data.inboxID);
                }
                yield* conversation.read((messages) => {
                  let count = 0;
                  for (const message of messages) {
                    if (!delivered.delete(message)) break;
                    count += 1;
                  }
                  return count;
                });
                break;
              }
              case "permission.asked":
                return yield* AgentResultError.make({
                  sessionId: Option.some(session.id),
                  message:
                    "OpenCode requested a headless permission despite the adapter's allow policy",
                });
              case "session.execution.failed":
                active = false;
                return yield* harnessFailure(
                  Option.some(session.id),
                  `OpenCode execution failed: ${event.data.error.type}: ${event.data.error.message}`,
                );
              case "session.execution.interrupted":
              case "session.execution.succeeded":
                if (interruption === "resuming" && !canceling) {
                  interruption = "none";
                  yield* Deferred.succeed(stopped, undefined);
                  stopped = yield* Deferred.make<void>();
                  yield* Effect.logInfo("OpenCode continues guidance after interruption", {
                    sessionId: session.id,
                  });
                  break;
                }
                interruption = "none";
                active = false;
                yield* Deferred.succeed(stopped, undefined);
                if (canceling)
                  yield* channel.fail(
                    AgentResultError.make({
                      sessionId: Option.some(session.id),
                      message: "OpenCode was interrupted",
                    }),
                  );
                else if (
                  event.type === "session.execution.succeeded" &&
                  lastText.trim().length === 0
                )
                  yield* channel.fail(
                    AgentResultError.make({
                      sessionId: Option.some(session.id),
                      message: "OpenCode completed without an assistant answer",
                    }),
                  );
                else yield* conversation.finish(lastText.trim() || "OpenCode was interrupted");
                break;
            }
          }),
        ),
        Effect.andThen(
          Effect.suspend(() =>
            closing
              ? Effect.void
              : channel.fail(
                  operationError(
                    client,
                    "stream",
                    "OpenCode event stream closed without a result",
                    new Error("unexpected end of events"),
                  ),
                ),
          ),
        ),
        Effect.catch((error) => channel.fail(error)),
      );
      yield* consume.pipe(Effect.forkScoped);
      yield* Deferred.await(connected).pipe(
        Effect.raceFirst(Deferred.await(channel.result).pipe(Effect.andThen(Effect.never))),
        Effect.timeout("30 seconds"),
        Effect.mapError((cause) =>
          operationError(client, "launch", "OpenCode event subscription did not connect", cause),
        ),
      );
      active = true;
      yield* connection.request("launch", "POST", `${path}/prompt`, {
        text: request.prompt,
        delivery: "steer",
      });
      yield* Effect.logInfo("OpenCode child started", {
        sessionId: session.id,
        harnessSessionId: saved.id,
        pool: route.pool,
      });
      return {
        session,
        events: Stream.fromQueue(channel.events),
        result: Deferred.await(channel.result),
        steer: (message) =>
          conversation.intervene(Steer.make({ message }), () => Effect.void).pipe(Effect.asVoid),
        intervene: conversation.intervene,
        interrupt: Effect.gen(function* () {
          canceling = true;
          if (!active)
            return yield* channel.fail(
              AgentResultError.make({
                sessionId: Option.some(session.id),
                message: "OpenCode was interrupted",
              }),
            );
          yield* pause;
          yield* Deferred.await(stopped).pipe(
            Effect.raceFirst(Deferred.await(channel.result).pipe(Effect.asVoid)),
            Effect.timeout("15 seconds"),
            Effect.catchTag("TimeoutError", (cause) =>
              operationError(client, "interrupt", "OpenCode interrupt did not settle", cause),
            ),
          );
        }),
      } satisfies RunningSession;
    },
    (effect, request) =>
      effect.pipe(
        Effect.tapError((error) =>
          Effect.logError("OpenCode child failed to start", {
            sessionId: request.session.id,
            errorTag: error._tag,
            message: error.message,
          }),
        ),
      ),
  );
  return { launch };
});

export const openCodeChildLayer = Layer.effect(ChildBackend, makeChild);

export const openCodeRuntime = Effect.gen(function* () {
  const child = yield* makeChild;
  const preflight = yield* openCodePreflight;
  return { id: opencode.id, launch: child.launch, preflight } satisfies HarnessRuntime;
});
