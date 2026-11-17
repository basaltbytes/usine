import { runSupervisorTurn } from "@usine/agents/supervisor";
import { NEEDS_LIMIT, TurnAccess, TurnAccessError } from "@usine/orchestrator/conversation/access";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { Authentication } from "../auth/authentication.ts";
import { routedOperatorCall } from "../mcp/http.ts";
import { loadOperatorTools, PublishedApi } from "../mcp/tools.ts";
import { operatorOpenApi } from "../openapi.ts";
import { memberOperatorToolkit } from "./toolkit.ts";

/** The most characters of one needs-you entry that a turn's context keeps. */
const NEED_CHARACTERS = 1_000;

const Attention = Schema.fromJsonString(Schema.Struct({ needsYou: Schema.Array(Schema.Json) }));
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

/**
 * Gives each supervisor turn read access as its member: a read-only credential that is issued
 * when the turn opens, lives only in memory, and ends with the turn; the operator tools that it
 * allows; and the needs-you entries that it reads. Every tool call and read goes through `router`
 * with that credential, so the route policy and audit apply as to the member's own requests.
 */
export const turnAccessLayer = Layer.effect(
  TurnAccess,
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const authentication = yield* Authentication;
    const document = yield* Schema.decodeUnknownEffect(PublishedApi)(operatorOpenApi()).pipe(
      Effect.orDie,
    );
    const tools = yield* loadOperatorTools(document);
    return TurnAccess.of({
      open: Effect.fn("Supervisor.turnAccess")(function* (member, credential, scope) {
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
        const operator = yield* memberOperatorToolkit(secret, tools, router, authentication).pipe(
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
