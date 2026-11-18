import { Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId } from "@usine/core/agent/session";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { MessageSizeMib, WorkerName } from "@usine/core/worker";
import { type Brand, Context, Effect, Option, Schema, type Scope } from "effect";
import { ExecShell, type ShellContainer } from "../../child-host/child-host.ts";
import { WorkingDirectory } from "../../runtime.ts";
import { CredentialRoute } from "../capability.ts";

/** Where supervisor sessions run on the orchestrator, and the credential route they use. */
export class SupervisorSeat extends Schema.Class<
  SupervisorSeat,
  Brand.Brand<"@usine/agents/harness/supervisor/SupervisorSeat">
>("@usine/agents/SupervisorSeat")({
  host: ExecShell.pipe(
    Schema.refine(
      (host): host is ExecShell & { readonly container: ShellContainer } =>
        host.container !== undefined,
      { message: "A supervisor seat requires an exec-shell host with a container" },
    ),
  ),
  /** The worker name that the session's process and logs carry. */
  worker: WorkerName,
  /** Maximum incoming harness protocol frame size in MiB. */
  protocolFrameMib: MessageSizeMib.pipe(
    Schema.withConstructorDefault(Effect.succeed(MessageSizeMib.make(4))),
  ),
  /** The directory that the conversation's harness process starts in. */
  cwd: WorkingDirectory,
  /** The complete environment of the harness process, with the gateway credential (ADR 0011). */
  environment: Schema.Record(Schema.String, Schema.String),
  credential: CredentialRoute,
  /**
   * Whether the sandbox holds the state that an earlier turn of the conversation saved. Without
   * it, the turn starts a new harness session.
   */
  restored: Schema.Boolean,
}) {}

/**
 * The source of one repository that supervisor sessions read: the tree of `revision`, exported to
 * `directory` on the orchestrator, without its git history.
 */
export class SupervisorSource extends Schema.Class<
  SupervisorSource,
  Brand.Brand<"@usine/agents/harness/supervisor/SupervisorSource">
>("@usine/agents/SupervisorSource")({
  repository: RepositoryName.check(
    Schema.makeFilter(
      (repository) => repository.split("/").every((part) => part !== "." && part !== ".."),
      { message: "A source repository cannot contain a . or .. path segment" },
    ),
  ),
  revision: CommitSha,
  directory: Schema.NonEmptyString,
}) {}

/** Why the orchestrator can't run supervisor sessions, such as a host without a container runtime. */
export class SupervisorUnavailable extends Schema.TaggedError<
  SupervisorUnavailable,
  Brand.Brand<"@usine/agents/harness/supervisor/SupervisorUnavailable">
>("@usine/agents/SupervisorUnavailable")("SupervisorUnavailable", {
  message: Schema.NonEmptyString,
}) {}

/** What one supervisor turn asks of the sandbox. */
export class SandboxRequest extends Schema.Class<
  SandboxRequest,
  Brand.Brand<"@usine/agents/harness/supervisor/SandboxRequest">
>("@usine/agents/SandboxRequest")({
  /** The usine session ID of the conversation, the same on every turn. */
  conversation: AgentSessionId,
  /** The harness that runs the turn, whose credential wiring the sandbox applies. */
  harness: Harness,
  /** The only model the sandbox may request through its relay. */
  model: ModelId,
  /** The repositories that the session reads, each in its own directory under the seat's `cwd`. */
  sources: Schema.Array(SupervisorSource),
}) {}

/**
 * The sandbox that every supervisor session runs in, on the orchestrator. The sources are
 * read-only, no instance secret is inside, the session reaches the model only through the route
 * that the instance already uses, and it reaches usine only through the tools that its harness
 * serves in band. The harness keeps its own tools; the sandbox limits what they reach.
 */
export interface SupervisorSandboxService {
  /**
   * Why sessions can't run on this orchestrator now, or `None` when they can. Sessions are
   * unavailable until the sandbox's startup check passes.
   */
  readonly unavailable: Effect.Effect<Option.Option<SupervisorUnavailable>>;
  /** Waits for the startup check to end, then returns `unavailable`. */
  readonly checked: Effect.Effect<Option.Option<SupervisorUnavailable>>;
  /**
   * Starts the sandbox of one turn and returns the seat that the turn's session runs on, with the
   * sources under its `cwd` and the conversation's saved state restored. Closing the scope saves
   * that state unless `save` ran, and removes the sandbox.
   */
  readonly open: (
    request: SandboxRequest,
  ) => Effect.Effect<SupervisorSeat, SupervisorUnavailable, Scope.Scope>;
  /**
   * Saves the conversation's state from the sandbox of `seat` for the next turn. A failure keeps
   * the state that an earlier turn saved.
   */
  readonly save: (seat: SupervisorSeat) => Effect.Effect<void, SupervisorUnavailable>;
}

const noSandbox = SupervisorUnavailable.make({
  message: "This orchestrator provides no supervisor sandbox",
});

/** The supervisor sandbox of this orchestrator. Without one, supervisor sessions are unavailable. */
export const SupervisorSandbox = Context.Reference<SupervisorSandboxService>(
  "@usine/agents/SupervisorSandbox",
  {
    defaultValue: () => ({
      unavailable: Effect.succeedSome(noSandbox),
      checked: Effect.succeedSome(noSandbox),
      open: () => Effect.fail(noSandbox),
      save: () => Effect.fail(noSandbox),
    }),
  },
);
