import { type AccessScope, InstanceScope } from "@usine/core/access";
import { ConfigurationEntityKey } from "@usine/config/configuration";
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
import {
  CallScopeTarget,
  entityRequirement,
  type ResolvedCall,
} from "@usine/orchestrator/operator";
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

/**
 * What a call acts on, in words, and what decides its scope; `None` is the instance.
 * `requirement` replaces the operation's declared permission and that scope when the target
 * decides them.
 */
interface Located {
  readonly target: string;
  readonly scope: Option.Option<CallScopeTarget>;
  readonly requirement?: { readonly permission: WritePermission; readonly scope: AccessScope };
}

const decode =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, what: string) =>
  (value: Option.Option<string>): Result.Result<S["Type"], string> =>
    Option.match(Option.flatMap(value, Schema.decodeUnknownOption(schema)), {
      onNone: () => Result.fail(`Pass ${what}.`),
      onSome: Result.succeed,
    });

const refusedBindings =
  "Role bindings are member access, which a supervisor turn can't request. A member changes them in Configuration > Role bindings.";
const refusedRevert =
  "A revert can change any configuration entity, role bindings included, which a supervisor turn can't request. A member reverts a revision in Configuration > History.";

/**
 * Returns the configuration entity that a write names and the permission and scope that the
 * configuration editor checks for it, or what is wrong with the arguments.
 */
const entityWrite = (args: ToolArguments): Result.Result<Located, string> => {
  const kind = Option.getOrElse(argument(args, "kind"), () => "");
  const identifier = Option.getOrElse(argument(args, "identifier"), () => "");
  const key = Schema.decodeUnknownOption(ConfigurationEntityKey)({ kind, identifier });
  if (Option.isNone(key))
    return Result.fail("Pass kind as a configuration entity kind, and identifier.");
  if (key.value.kind === "binding") return Result.fail(refusedBindings);
  const requirement = Option.flatMap(entityRequirement(key.value, "maintain"), (needed) =>
    Option.map(
      // A maintainer can change only a project's lanes; the editor requires an admin for the rest.
      Schema.decodeUnknownOption(WritePermission)(
        key.value.kind === "project" ? "admin" : needed.permission,
      ),
      (permission) => ({ permission, scope: needed.scope }),
    ),
  );
  if (Option.isNone(requirement)) return Result.fail("Pass identifier as a project ID.");
  return Result.succeed({
    target: `${kind} ${identifier}`,
    scope: Option.none(),
    requirement: requirement.value,
  });
};

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
      return entityWrite(args);
    case "revertConfigurationRevision":
      return Result.fail(refusedRevert);
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
 * Returns `args` with the loop that the call resolved to, for an operation that names its loop by
 * `loop` alone, so that the stored call runs on the loop that the member saw.
 */
const resolvedArguments = (tool: OperatorTool, args: ToolArguments, target: CallScopeTarget) =>
  target._tag === "Loop" && !tool.pathParameters.includes("project")
    ? { ...args, loop: target.loop }
    : args;

/**
 * Returns the operation call that a turn makes with `tool` and `args`: its target in words, the
 * scope that its permission is checked on, which `scopeOf` resolves for a target in a project,
 * and the permission that it needs. A short loop name is stored qualified with its project. Fails
 * with the text that the model reads when the arguments are invalid, the target is refused, or
 * `scopeOf` fails.
 */
export const operationCall = Effect.fn("Supervisor.operationCall")(function* (
  tool: OperatorTool,
  args: ToolArguments,
  scopeOf: (target: CallScopeTarget) => Effect.Effect<ResolvedCall, string>,
) {
  yield* Effect.annotateCurrentSpan({ tool: tool.name });
  const request = operatorRequest(tool, args);
  if (Result.isFailure(request)) return yield* Effect.fail(request.failure);
  const located = locate(tool, args);
  if (Result.isFailure(located)) {
    yield* Effect.logInfo("Supervisor call refused", { tool: tool.name, reason: located.failure });
    return yield* Effect.fail(located.failure);
  }
  const { requirement } = located.success;
  const permission =
    requirement === undefined
      ? Schema.decodeUnknownOption(WritePermission)(tool.permission)
      : Option.some(requirement.permission);
  if (Option.isNone(permission))
    return yield* Effect.die(new Error(`The ${tool.name} tool needs no more than read`));
  const resolved = yield* Effect.transposeOption(Option.map(located.success.scope, scopeOf));
  const target = Option.match(resolved, {
    onNone: () => located.success.target,
    onSome: ({ target: resolvedTarget }) =>
      resolvedTarget._tag === "Loop" ? `loop ${resolvedTarget.loop}` : located.success.target,
  });
  return OperationCall.make({
    operation: OperationName.make(tool.name),
    summary: tool.descriptor.title ?? tool.name,
    arguments: Option.match(resolved, {
      onNone: () => args,
      onSome: (call) => resolvedArguments(tool, args, call.target),
    }),
    target: CallTarget.make(target.slice(0, 300)),
    scope:
      requirement?.scope ??
      Option.match(resolved, {
        onNone: () => InstanceScope.make(),
        onSome: ({ scope }) => scope,
      }),
    permission: permission.value,
  });
});
