import { runSupervisorTurn } from "@usine/agents/supervisor";
import { RequestPermissions } from "@usine/core/access";
import {
  NEEDS_LIMIT,
  TurnAccess,
  TurnAccessError,
  type TurnRequests,
} from "@usine/orchestrator/conversation/access";
import type { CallScopeTarget } from "@usine/orchestrator/operator";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { Authentication } from "../auth/authentication.ts";
import type { OperationId } from "../auth/model.ts";
import { FactoryBackend } from "../backend.ts";
import { routedOperatorCall } from "../mcp/http.ts";
import { loadOperatorTools, type OperatorTool, PublishedApi } from "../mcp/tools.ts";
import { operatorOpenApi } from "../openapi.ts";
import { operationCall } from "./calls.ts";
import { type GatedCall, gatedResult, gatedTools, memberOperatorToolkit } from "./toolkit.ts";

/** The most characters of one needs-you entry that a turn's context keeps. */
const NEED_CHARACTERS = 1_000;

const TARGET_NOUNS = {
  Run: "run",
  Repository: "repository",
  Loop: "loop",
  CycleBudgetAsk: "cycle budget ask",
} as const satisfies Record<CallScopeTarget["_tag"], string>;

const Attention = Schema.fromJsonString(Schema.Struct({ needsYou: Schema.Array(Schema.Json) }));
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

/** What a turn's toolkit needs from the server. */
export interface TurnServices {
  readonly tools: ReadonlyArray<OperatorTool>;
  readonly router: HttpRouter.HttpRouter;
  readonly authentication: Authentication["Service"];
  readonly backend: FactoryBackend["Service"];
}

/**
 * Returns the operator toolkit of a turn whose read-only credential is `secret`: the read tools
 * that the credential allows, answered through the router with it, and the tools that need more
 * than `read` within the posting token's operation `ceiling`. A call of one of those resolves its
 * target's scope with the turn's current read access and goes to `requests`, which run it under a
 * standing grant or store a permission request; it never reaches the router with the turn's
 * credential.
 */
export const turnToolkit = Effect.fn("Supervisor.turnToolkit")(function* (
  services: TurnServices,
  secret: Redacted.Redacted<string>,
  ceiling: Option.Option<ReadonlyArray<OperationId>>,
  requests: TurnRequests,
) {
  const { authentication, backend } = services;
  // Resolved with the turn's current read access, so a target it can't read is not found.
  const scopeOf = (target: CallScopeTarget) =>
    authentication.authenticate(Redacted.value(secret)).pipe(
      Effect.mapError(({ message }) => message),
      Effect.flatMap((current) =>
        backend.callScope(target).pipe(
          Effect.provideService(RequestPermissions, current.permissions),
          Effect.tapError((error) =>
            Effect.logInfo("Supervisor call refused: its target can't be read", {
              target: target._tag,
              error: error._tag,
            }),
          ),
          Effect.mapError(() => `The ${TARGET_NOUNS[target._tag]} of the call was not found.`),
        ),
      ),
    );
  const gate: GatedCall = (tool, args, toolCall) =>
    operationCall(tool, args, scopeOf).pipe(
      Effect.flatMap((call) =>
        requests.call(call, toolCall).pipe(
          Effect.catchTags({
            CallOutsideScope: ({ message }) => Effect.fail(message),
            PermissionStoreError: ({ operation }) =>
              Effect.logError("Supervisor permission request not stored", {
                tool: tool.name,
                operation,
              }).pipe(Effect.andThen(Effect.fail("usine couldn't store the permission request."))),
          }),
        ),
      ),
      Effect.flatMap(gatedResult),
    );
  return yield* memberOperatorToolkit(
    secret,
    services.tools,
    services.router,
    authentication,
    gatedTools(services.tools, ceiling),
    gate,
  );
});

/**
 * Gives each supervisor turn read access as its member: a read-only credential that is issued
 * when the turn opens, lives only in memory, and ends with the turn; the operator tools of
 * `turnToolkit`; and the needs-you entries that it reads. Every read goes through the router with
 * that credential, so the route policy and audit apply as to the member's own requests.
 */
export const turnAccessLayer = Layer.effect(
  TurnAccess,
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const authentication = yield* Authentication;
    const backend = yield* FactoryBackend;
    const document = yield* Schema.decodeUnknownEffect(PublishedApi)(operatorOpenApi()).pipe(
      Effect.orDie,
    );
    const tools = yield* loadOperatorTools(document);
    const services: TurnServices = { tools, router, authentication, backend };
    return TurnAccess.of({
      open: Effect.fn("Supervisor.turnAccess")(function* (member, credential, scope, requests) {
        yield* Effect.annotateCurrentSpan({ member: member.login });
        const refused = ({ message }: { readonly message: string }) =>
          TurnAccessError.make({
            message: `usine couldn't act as ${member.login}: ${message}`,
          });
        const posting = yield* authentication
          .postingAccess(member.id, credential)
          .pipe(Effect.mapError(({ message }) => TurnAccessError.make({ message })));
        const secret = yield* authentication.turnCredential(member.id, scope, credential);
        const access = yield* authentication
          .authenticate(Redacted.value(secret))
          .pipe(Effect.mapError(refused));
        const operator = yield* turnToolkit(services, secret, posting.operations, requests).pipe(
          Effect.mapError(refused),
        );
        const handlers = yield* Layer.build(operator.handlers);
        const response = yield* routedOperatorCall(router, {
          authorization: `Bearer ${Redacted.value(secret)}`,
          "x-usine-view": "attention",
        })({ method: "GET", url: "/api/overview", body: Option.none() }).pipe(
          Effect.mapError(refused),
        );
        if (response.status !== 200)
          return yield* refused({ message: `reading the overview returned ${response.status}` });
        const { needsYou } = yield* Schema.decodeEffect(Attention)(response.text).pipe(
          Effect.mapError(() => refused({ message: "the overview could not be read" })),
        );
        const listed = yield* Effect.forEach(needsYou.slice(0, NEEDS_LIMIT), (need) =>
          jsonText(need).pipe(
            Effect.orDie,
            Effect.map((text) => text.slice(0, NEED_CHARACTERS)),
          ),
        );
        yield* Effect.logInfo("Supervisor turn acts as its member", {
          member: member.login,
          grants: access.permissions.length,
          needsYou: needsYou.length,
        });
        return {
          posterGrants: posting.permissions,
          grants: access.permissions,
          needsYou: listed,
          needsTotal: needsYou.length,
          run: (turn, observe) =>
            runSupervisorTurn(turn, operator.toolkit, observe).pipe(
              Effect.provideContext(handlers),
            ),
        };
      }),
    });
  }),
);
