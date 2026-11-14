import { Context, Effect, Option, Schema, type Scope, Stream } from "effect";
import type { AgentSessionId } from "@usine/core/agent/session";
import type { MessageSizeMib } from "@usine/core/worker";
import type { ChildHost } from "../../child-host/child-host.ts";
import { type WorkingDirectory, SessionOperationError } from "../../runtime.ts";

/** The settings of one app-server connection. */
export interface CodexClient {
  /** The checkout directory on `host`. */
  readonly cwd: WorkingDirectory;
  /** `None` during preflight, before a child session exists. */
  readonly sessionId: Option.Option<AgentSessionId>;
  /**
   * The complete environment of the app server and its commands on a local host, or the variables
   * exported on top of a remote host's environment.
   */
  readonly environment: Readonly<Record<string, string>>;
  /** The local or remote host on which to start the app-server process. */
  readonly host: ChildHost;
  /** Incoming frame bound for roles that protect the orchestrator host. */
  readonly protocolFrameMib?: MessageSizeMib | undefined;
  /** Reattach the retained process, or confirm its termination before replacement. */
  readonly transport?: "replace" | "resume";
  /**
   * Answers a request that the app server sends to the client, or returns `None` for a method it
   * doesn't serve, which the connection refuses. Each answer runs in its own fiber, so a slow
   * answer doesn't hold back notifications; closing the connection interrupts it.
   */
  readonly serve?: (request: CodexServerRequest) => Option.Option<Effect.Effect<Schema.Json>>;
}

/** A request that the app server sends to the client, such as `item/tool/call`. */
export interface CodexServerRequest {
  readonly method: string;
  /** The protocol payload, decoded by the handler for the named method. */
  readonly params: Schema.Json;
}

/** A server event received without a client request ID. */
export interface CodexNotification {
  /** The protocol method name used to select the notification decoder. */
  readonly method: string;
  /** The protocol payload, decoded by the child backend for the named method. */
  readonly params: Schema.Json;
}

/** A JSON-RPC connection to the app server, scoped to its process. */
export interface CodexConnection {
  /** Closes stdin and waits for the app server to shut down its threads and commands. */
  readonly close: Effect.Effect<void, SessionOperationError>;
  /** Server events in receive order; fails if the process or its output stream fails. */
  readonly notifications: Stream.Stream<CodexNotification, SessionOperationError>;
  /**
   * Sends `method` with its JSON `params` and waits up to 60 seconds for the matching response.
   * Failures identify `operation`; a failed connection returns its recorded failure unchanged.
   * The caller decodes the returned protocol payload.
   */
  readonly request: (
    operation: SessionOperationError["operation"],
    method: string,
    params: Schema.Json,
  ) => Effect.Effect<Schema.Json, SessionOperationError>;
  /**
   * Sends `method` with its JSON `params` without waiting for a response. Write failures identify
   * `operation`, such as `launch` for the initialization acknowledgement.
   */
  readonly notify: (
    operation: SessionOperationError["operation"],
    method: string,
    params: Schema.Json,
  ) => Effect.Effect<void, SessionOperationError>;
}

/** The service that spawns the Codex app-server process and provides its JSON-RPC connection. */
export class CodexAppServer extends Context.Service<
  CodexAppServer,
  {
    /** Stops the process retained for this child. */
    readonly stop: (request: CodexClient) => Effect.Effect<void, SessionOperationError>;
    /**
     * Starts the app server on `request.host` with its environment and session identity. The
     * connection belongs to the calling scope; the caller initializes the JSON-RPC protocol.
     */
    readonly open: (
      request: CodexClient,
    ) => Effect.Effect<CodexConnection, SessionOperationError, Scope.Scope>;
  }
>()("@usine/agents/harness/codex/connection/CodexAppServer") {}

export const operationError = (
  operation: SessionOperationError["operation"],
  request: CodexClient,
  message: string,
  cause: unknown,
): SessionOperationError =>
  SessionOperationError.make({
    operation,
    sessionId: request.sessionId,
    message,
    cause,
  });
