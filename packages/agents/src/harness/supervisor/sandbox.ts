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
  /** Why sessions can't run on this orchestrator, or `None` when they can. */
  readonly unavailable: Option.Option<SupervisorUnavailable>;
  /**
   * Starts the sandbox of one turn and returns the seat that the turn's session runs on, with the
   * sources under its `cwd`. Closing the scope removes the sandbox; the conversation's saved
   * sessions stay for its next turn.
   */
  readonly open: (
    request: SandboxRequest,
  ) => Effect.Effect<SupervisorSeat, SupervisorUnavailable, Scope.Scope>;
}

const noSandbox = SupervisorUnavailable.make({
  message: "This orchestrator provides no supervisor sandbox",
});

/** The supervisor sandbox of this orchestrator. Without one, supervisor sessions are unavailable. */
export const SupervisorSandbox = Context.Reference<SupervisorSandboxService>(
  "@usine/agents/SupervisorSandbox",
  {
    defaultValue: () => ({
      unavailable: Option.some(noSandbox),
      open: () => Effect.fail(noSandbox),
    }),
  },
);
