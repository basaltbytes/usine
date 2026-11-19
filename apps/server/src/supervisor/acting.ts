import { permits } from "@usine/core/access";
import { callCeiling, type CallOutcome } from "@usine/core/permission-request";
import { ActingCalls, ActorRefused } from "@usine/orchestrator/conversation/permissions/acting";
import { Effect, Layer, Redacted, Result, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { Authentication } from "../auth/authentication.ts";
import { ceilingAdmits, OperationId } from "../auth/model.ts";
import { routedOperatorCall } from "../mcp/http.ts";
import { loadOperatorTools, operatorRequest, PublishedApi, toolResult } from "../mcp/tools.ts";
import { operatorOpenApi } from "../openapi.ts";

/** The OpenAPI operation ID of the operator operation `name`. */
const operationId = (name: string) => OperationId.make(`operator.${name}`);

/**
 * Runs the calls that members allow as those members. A member's access is their current role
 * bindings within the credential they answered with. Each call goes through `router` with a
 * credential that lives only for the call, has the member's access within the call's scope, and
 * can call only the call's operation, so the route policy, the operation's own checks, and its
 * audit apply, and the audit names the member.
 */
export const actingCallsLayer = Layer.effect(
  ActingCalls,
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const authentication = yield* Authentication;
    const document = yield* Schema.decodeUnknownEffect(PublishedApi)(operatorOpenApi()).pipe(
      Effect.orDie,
    );
    const tools = new Map((yield* loadOperatorTools(document)).map((tool) => [tool.name, tool]));
    return ActingCalls.of({
      access: Effect.fn("Supervisor.actorAccess")(function* ({ member, credential }) {
        yield* Effect.annotateCurrentSpan({ member: member.login });
        const posting = yield* authentication
          .postingAccess(member.id, credential)
          .pipe(Effect.mapError(({ message }) => ActorRefused.make({ message })));
        return {
          permits: ({ operation, permission, scope }) =>
            permits(posting.permissions, permission, scope) &&
            ceilingAdmits(posting.operations, operationId(operation)),
        };
      }),
      run: Effect.fn("Supervisor.runAllowedCall")(function* ({ member, credential }, call) {
        yield* Effect.annotateCurrentSpan({ member: member.login, operation: call.operation });
        const tool = tools.get(call.operation);
        if (tool === undefined)
          return {
            _tag: "Refused",
            error: `The operation ${call.operation} no longer exists.`,
          } satisfies CallOutcome;
        const request = operatorRequest(tool, call.arguments);
        if (Result.isFailure(request))
          return { _tag: "Refused", error: request.failure } satisfies CallOutcome;
        const response = yield* Effect.scoped(
          Effect.gen(function* () {
            const secret = yield* authentication.callCredential(
              member.id,
              credential,
              callCeiling(call),
              operationId(call.operation),
            );
            return yield* routedOperatorCall(router, {
              authorization: `Bearer ${Redacted.value(secret)}`,
            })(request.success);
          }),
        );
        const result = toolResult(tool, response);
        const text = result.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        yield* Effect.logInfo("Ran an allowed supervisor call", {
          member: member.login,
          operation: call.operation,
          status: response.status,
        });
        return result.isError === true
          ? ({ _tag: "Refused", error: text } satisfies CallOutcome)
          : ({ _tag: "Succeeded", result: text } satisfies CallOutcome);
      }),
    });
  }),
);
