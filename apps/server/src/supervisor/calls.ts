import { type AccessScope, InstanceScope } from "@usine/core/access";
import { CycleBudgetAskId } from "@usine/core/cycle-budget";
import { LoopName } from "@usine/core/loop";
import {
  CallTarget,
  OperationCall,
  OperationName,
  WritePermission,
} from "@usine/core/permission-request";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { CallScopeTarget } from "@usine/orchestrator/operator";
import { Effect, Option, Result, Schema } from "effect";
import { type OperatorTool, operatorRequest, type ToolArguments } from "../mcp/tools.ts";

/** The operations whose target is a run, named by `runId`. */
const RUN_OPERATIONS: ReadonlySet<string> = new Set([
  "approve",
  "resolveFailure",
  "applyCiLabels",
  "retry",
  "cancel",
  "editAndRetry",
  "runAgain",
  "intervene",
]);

const Scalar = Schema.Union([Schema.String, Schema.Finite]);
const Body = Schema.Record(Schema.String, Schema.Json);

/** The text of the scalar argument `name`, if the call has one. */
const argument = (args: ToolArguments, name: string) =>
  Schema.decodeUnknownOption(Scalar)(args[name]).pipe(Option.map(String));

/** The text of the scalar field `name` of the call's body, if it has one. */
const bodyField = (args: ToolArguments, name: string) =>
  Schema.decodeUnknownOption(Body)(args.body).pipe(Option.flatMap((body) => argument(body, name)));

/** What a call acts on, in words, and what decides its scope; `None` is the instance. */
interface Located {
  readonly target: string;
  readonly scope: Option.Option<CallScopeTarget>;
}

const decode =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, what: string) =>
  (value: Option.Option<string>): Result.Result<S["Type"], string> =>
    Option.match(Option.flatMap(value, Schema.decodeUnknownOption(schema)), {
      onNone: () => Result.fail(`Pass ${what}.`),
      onSome: Result.succeed,
    });

/** Returns what the call of `tool` with `args` acts on, or what is wrong with the arguments. */
const locate = (tool: OperatorTool, args: ToolArguments): Result.Result<Located, string> => {
  const name = tool.name;
  if (RUN_OPERATIONS.has(name))
    return Result.map(decode(RunId, "runId as a run ID")(argument(args, "runId")), (runId) => ({
      target: `run ${runId}`,
      scope: Option.some(CallScopeTarget.Run({ runId })),
    }));
  switch (name) {
    case "moveProjectItem":
      return Result.map(
        decode(RepositoryName, "body.repository as owner/name")(bodyField(args, "repository")),
        (repository) => ({
          target: `${repository}#${Option.getOrElse(argument(args, "item"), () => "?")}`,
          scope: Option.some(CallScopeTarget.Repository({ repository })),
        }),
      );
    case "moveBoardItem": {
      const owner = argument(args, "owner");
      const repository = argument(args, "repository");
      return Result.map(
        decode(
          RepositoryName,
          "owner and repository",
        )(Option.zipWith(owner, repository, (left, right) => `${left}/${right}`)),
        (full) => ({
          target: `${full}#${Option.getOrElse(argument(args, "item"), () => "?")}`,
          scope: Option.some(CallScopeTarget.Repository({ repository: full })),
        }),
      );
    }
    case "pauseProjectLoop":
    case "unpauseProjectLoop": {
      const project = argument(args, "project");
      const loop = argument(args, "loop");
      return Result.map(
        decode(
          LoopName,
          "project and loop",
        )(Option.zipWith(project, loop, (left, right) => `${left}/${right}`)),
        (qualified) => ({
          target: `loop ${qualified}`,
          scope: Option.some(CallScopeTarget.Loop({ loop: qualified })),
        }),
      );
    }
    case "pause":
    case "unpause":
      return Result.map(
        decode(LoopName, "loop as a loop name")(argument(args, "loop")),
        (loop) => ({
          target: `loop ${loop}`,
          scope: Option.some(CallScopeTarget.Loop({ loop })),
        }),
      );
    case "resetCycleBudget":
      return Result.map(
        decode(CycleBudgetAskId, "body.askId as a cycle budget ask ID")(bodyField(args, "askId")),
        (askId) => ({
          target: `cycle budget ask ${askId}`,
          scope: Option.some(CallScopeTarget.CycleBudgetAsk({ askId })),
        }),
      );
    case "runWorkerPreflight":
    case "discardLeftovers":
      return Result.succeed({
        target: `worker ${Option.getOrElse(argument(args, "worker"), () => "?")}`,
        scope: Option.none(),
      });
    case "replaceConfigurationEntity":
    case "deleteConfigurationEntity":
      return Result.succeed({
        target: `${Option.getOrElse(argument(args, "kind"), () => "entity")} ${Option.getOrElse(argument(args, "identifier"), () => "?")}`,
        scope: Option.none(),
      });
    case "revertConfigurationRevision":
      return Result.succeed({
        target: `configuration revision ${Option.getOrElse(argument(args, "number"), () => "?")}`,
        scope: Option.none(),
      });
    case "dismissNeed":
    case "undoDismissNeed":
      return Result.succeed({
        target: `attention item ${Option.getOrElse(bodyField(args, "id"), () => "?")}`,
        scope: Option.none(),
      });
    default:
      return Result.succeed({ target: "the instance", scope: Option.none() });
  }
};

/**
 * Returns the operation call that a turn makes with `tool` and `args`: its target in words, and
 * the scope that its permission is checked on, which `scopeOf` resolves for a target in a project.
 * Fails with the text that the model reads when the arguments are invalid or `scopeOf` fails.
 */
export const operationCall = Effect.fn("Supervisor.operationCall")(function* (
  tool: OperatorTool,
  args: ToolArguments,
  scopeOf: (target: CallScopeTarget) => Effect.Effect<AccessScope, string>,
) {
  yield* Effect.annotateCurrentSpan({ tool: tool.name });
  const request = operatorRequest(tool, args);
  if (Result.isFailure(request)) return yield* Effect.fail(request.failure);
  const located = locate(tool, args);
  if (Result.isFailure(located)) return yield* Effect.fail(located.failure);
  const permission = Schema.decodeUnknownOption(WritePermission)(tool.permission);
  if (Option.isNone(permission))
    return yield* Effect.die(new Error(`The ${tool.name} tool needs no more than read`));
  const scope = yield* Option.match(located.success.scope, {
    onNone: () => Effect.succeed<AccessScope>(InstanceScope.make()),
    onSome: scopeOf,
  });
  return OperationCall.make({
    operation: OperationName.make(tool.name),
    summary: tool.descriptor.title ?? tool.name,
    arguments: args,
    target: CallTarget.make(located.success.target.slice(0, 300)),
    scope,
    permission: permission.value,
  });
});
