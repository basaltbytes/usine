import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  type BashSpawnHook,
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Effort, ModelId } from "@usine/core/agent/brain";
import { Context, Effect, Exit, Layer, Option } from "effect";
import {
  type PiAuthentication,
  type PiPool,
  piAuthentication,
  resolvePiPool,
  splitPiModel,
} from "./authentication.ts";

/** A Pi SDK event before conversion to the attempt channel's session events. */
export type PiSessionEvent = AgentSessionEvent;
export type PiMessage = Awaited<
  ReturnType<typeof createAgentSession>
>["session"]["messages"][number];

/** The subset of an in-process Pi session that the adapter uses. */
export interface PiSession {
  /** The session transcript used to read the final assistant answer and token usage. */
  readonly messages: ReadonlyArray<PiMessage>;
  /** Registers an SDK event listener and returns the function that removes it. */
  readonly subscribe: (listener: (event: PiSessionEvent) => void) => () => void;
  /** Sends the task text and waits for the turn to settle; SDK failures reject the promise. */
  readonly prompt: (prompt: string) => Promise<void>;
  /** Queues guidance for the next model call; `handled` means an input hook consumed it. The backend treats `queued` and `void` as awaiting delivery. */
  readonly steer: (message: string) => Promise<"handled" | "queued" | void>;
  /** Stops the active turn and waits for the agent to become idle. */
  readonly abort: () => Promise<void>;
  /** Releases SDK resources and listeners when the caller is done with the session. */
  readonly dispose: () => void;
}

/** The checkout, model, and tool configuration used to start an in-process Pi session. */
export interface PiStartOptions {
  /** The checkout directory used by repository tools and session settings. */
  readonly cwd: string;
  /** The complete environment of every command the bash tool runs; `None` inherits this process's environment. */
  readonly environment: Option.Option<Readonly<Record<string, string>>>;
  /** Trusted inline extensions to register, such as the operator pause gate. */
  readonly extensions: ReadonlyArray<InlineExtension>;
  /** The requested model in `provider/model` form. */
  readonly model: ModelId;
  /** Cancels SDK startup and authentication requests. */
  readonly signal: AbortSignal;
  /** The requested reasoning effort, checked against the active model's supported levels. */
  readonly thinkingLevel: Effort;
}

/** The result of Pi startup and credential checks. Only `Started` transfers a live session to the caller, which must dispose it. */
export type PiStartResult =
  | {
      /** No credential is available for the active model's provider. */
      readonly _tag: "AuthenticationUnavailable";
      /** The active model after Pi applies its settings, in `provider/model` form. */
      readonly model: ModelId;
    }
  | {
      /** The provider credential cannot use a supported Pi billing pool. */
      readonly _tag: "UnsupportedAuthentication";
      /** The rejected OAuth credential category, without credential values. */
      readonly authentication: Extract<PiAuthentication, { readonly _tag: "OAuth" }>;
      /** The active model after Pi applies its settings, in `provider/model` form. */
      readonly model: ModelId;
    }
  | {
      /** The model ID is malformed or absent from Pi's registry. */
      readonly _tag: "UnknownModel";
    }
  | {
      /** The active model does not support the requested reasoning effort. */
      readonly _tag: "UnsupportedEffort";
      /** The reasoning effort requested at startup. */
      readonly effort: Effort;
      /** The active model after Pi applies its settings, in `provider/model` form. */
      readonly model: ModelId;
      /** The reasoning levels accepted by the active model. */
      readonly supported: ReadonlyArray<Effort>;
    }
  | {
      /** Startup succeeded; the caller must dispose the returned session. */
      readonly _tag: "Started";
      /** The active model after Pi applies its settings, in `provider/model` form. */
      readonly model: ModelId;
      /** The billing pool resolved from the active model's credential. */
      readonly pool: PiPool;
      /** The live in-memory session owned by the caller. */
      readonly session: PiSession;
      /** The names of the tools active in `session`. */
      readonly tools: ReadonlyArray<string>;
    };

/** Returns a bash tool whose commands run with exactly `environment`; Pi's `PI_*` variables are not added. */
export const environmentBashTool = (
  cwd: string,
  environment: Readonly<Record<string, string>>,
): ToolDefinition => {
  const exact: BashSpawnHook = (context) => ({ ...context, env: { ...environment } });
  return defineTool(
    createBashToolDefinition(cwd, { exposeSessionEnvironment: false, spawnHook: exact }),
  );
};

/**
 * Pi's default tools, named so that the global `defaultTools` setting can't add a tool whose
 * processes inherit this process's environment, such as `grep` or `find`.
 */
const piChildToolNames = ["read", "bash", "edit", "write"];

/**
 * Returns the session options that give a Pi child exactly Pi's default tools. With `environment`,
 * the bash tool runs its commands with exactly that environment.
 */
export const piChildTools = (
  cwd: string,
  environment: Option.Option<Readonly<Record<string, string>>>,
): Pick<CreateAgentSessionOptions, "customTools" | "tools"> => ({
  tools: [...piChildToolNames],
  // A custom tool replaces the built-in tool of the same name.
  customTools: Option.match(environment, {
    onNone: () => [],
    onSome: (exact) => [environmentBashTool(cwd, exact)],
  }),
});

/** The service that starts a Pi session with the selected model and its repository tools. */
export class PiSdk extends Context.Service<
  PiSdk,
  {
    /**
     * Starts a session with `options` and checks its active model and credential. Returns a
     * rejection variant for an unsupported configuration; SDK failures reject the promise.
     * The caller owns disposal of a `Started` session, including if startup finishes after cancellation.
     */
    readonly start: (options: PiStartOptions) => Promise<PiStartResult>;
  }
>()("@usine/agents/pi/PiSdk") {}

/** Provides Pi sessions using the installed SDK and worker-user settings. Project extensions, skills, prompt templates, and themes are disabled; sessions are kept in memory. */
export const piSdkLive = Layer.succeed(PiSdk)({
  start: async (options) => {
    const modelRuntime = await ModelRuntime.create({ signal: options.signal });
    const parts = splitPiModel(options.model);
    if (parts === undefined) return { _tag: "UnknownModel" };
    const selected = modelRuntime.getModel(parts.provider, parts.modelId);
    if (selected === undefined) return { _tag: "UnknownModel" };
    const agentDir = getAgentDir();
    // The worktree is untrusted, so its `.pi/` settings, SYSTEM.md, extensions, and skills are not
    // loaded; inline extension factories, such as the pause gate, still register.
    const settingsManager = SettingsManager.create(options.cwd, agentDir, {
      projectTrusted: false,
    });
    const resourceLoader = new DefaultResourceLoader({
      agentDir,
      cwd: options.cwd,
      extensionFactories: [...options.extensions],
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      ...piChildTools(options.cwd, options.environment),
      cwd: options.cwd,
      model: selected,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager,
      thinkingLevel: options.thinkingLevel,
    });
    let ownershipTransferred = false;
    try {
      const active = session.model;
      if (active === undefined) throw new Error("Pi started without an active model");
      const model = ModelId.make(`${active.provider}/${active.id}`);
      const supported = getSupportedThinkingLevels(active);
      if (!supported.includes(options.thinkingLevel)) {
        return { _tag: "UnsupportedEffort", effort: options.thinkingLevel, model, supported };
      }
      const authentication = piAuthentication(
        await modelRuntime.checkAuth(active.provider, { signal: options.signal }),
        modelRuntime.getProvider(active.provider)?.auth.oauth?.isSubscription === true,
      );
      const pool = resolvePiPool(active.provider, authentication);
      if (authentication === undefined) {
        return { _tag: "AuthenticationUnavailable", model };
      }
      if (pool === undefined && authentication._tag === "OAuth") {
        return { _tag: "UnsupportedAuthentication", authentication, model };
      }
      if (pool === undefined) {
        throw new Error("Pi could not map a configured API key to a billing pool");
      }
      ownershipTransferred = true;
      return {
        _tag: "Started",
        model,
        pool,
        session,
        tools: session.getActiveToolNames(),
      };
    } finally {
      if (!ownershipTransferred) session.dispose();
    }
  },
});

export interface AcquiredPiStart {
  readonly result: PiStartResult;
  /** Disposes the session; idempotent, because both failed setup and the enclosing scope can call it. */
  readonly dispose: () => void;
}

/**
 * Runs SDK startup so an interruption cannot leak a session: a result that arrives after the
 * interruption is disposed when its Promise settles, and one passed to `use` is disposed on exit.
 */
export const usePiStart = <A, E, R, E2>(
  start: (signal: AbortSignal) => Promise<PiStartResult>,
  onError: (cause: unknown) => E,
  use: (acquired: AcquiredPiStart) => Effect.Effect<A, E2, R>,
): Effect.Effect<A, E | E2, R> =>
  Effect.suspend(() => {
    let acquired: AcquiredPiStart | undefined;
    let abandoned = false;
    let pending = true;
    const acquire = Effect.tryPromise({
      try: (signal) =>
        start(signal).then(
          (result) => {
            pending = false;
            let disposed = false;
            acquired = {
              result,
              dispose: () => {
                if (disposed) return;
                disposed = true;
                if (result._tag === "Started") result.session.dispose();
              },
            };
            if (abandoned || signal.aborted) acquired.dispose();
            return acquired;
          },
          (cause) => {
            pending = false;
            throw cause;
          },
        ),
      catch: onError,
    });
    return acquire.pipe(
      Effect.flatMap(use),
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) return Effect.void;
        abandoned = true;
        if (acquired?.result._tag === "Started") {
          return Effect.logWarning("Disposing Pi session after an incomplete launch", {
            model: acquired.result.model,
            pool: acquired.result.pool,
          }).pipe(Effect.andThen(Effect.sync(acquired.dispose)));
        }
        return pending
          ? Effect.logWarning(
              "Pi launch ended during SDK startup; any late-created session will be disposed",
            )
          : Effect.void;
      }),
    );
  });
