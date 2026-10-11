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
import { supportedThinkingLevels } from "./thinking.ts";

export type PiSessionEvent = AgentSessionEvent;
export type PiMessage = Awaited<
  ReturnType<typeof createAgentSession>
>["session"]["messages"][number];

/** The subset of an in-process Pi session that the adapter uses. */
export interface PiSession {
  readonly messages: ReadonlyArray<PiMessage>;
  readonly subscribe: (listener: (event: PiSessionEvent) => void) => () => void;
  readonly prompt: (prompt: string) => Promise<void>;
  readonly steer: (message: string) => Promise<"handled" | "queued" | void>;
  readonly abort: () => Promise<void>;
  readonly dispose: () => void;
}

export interface PiStartOptions {
  readonly cwd: string;
  /**
   * The complete environment of every command the session's bash tool runs.
   * None inherits this process's environment, which suits preflight because
   * it runs no repository command.
   */
  readonly environment: Option.Option<Readonly<Record<string, string>>>;
  readonly extensions: ReadonlyArray<InlineExtension>;
  readonly model: ModelId;
  readonly signal: AbortSignal;
  readonly thinkingLevel: Effort;
}

export type PiStartResult =
  | {
      readonly _tag: "AuthenticationUnavailable";
      readonly model: ModelId;
    }
  | {
      readonly _tag: "UnsupportedAuthentication";
      readonly authentication: Extract<PiAuthentication, { readonly _tag: "OAuth" }>;
      readonly model: ModelId;
    }
  | { readonly _tag: "UnknownModel" }
  | {
      readonly _tag: "UnsupportedEffort";
      readonly effort: Effort;
      readonly model: ModelId;
      readonly supported: ReadonlyArray<Effort>;
    }
  | {
      readonly _tag: "Started";
      readonly model: ModelId;
      readonly pool: PiPool;
      readonly session: PiSession;
    };

/**
 * The bash tool of a session whose commands run with exactly `environment`,
 * replacing what the tool would inherit; Pi's own `PI_*` variables are not added.
 */
export const environmentBashTool = (
  cwd: string,
  environment: Readonly<Record<string, string>>,
): ToolDefinition => {
  const exact: BashSpawnHook = (context) => ({ ...context, env: { ...environment } });
  return defineTool(
    createBashToolDefinition(cwd, { exposeSessionEnvironment: false, spawnHook: exact }),
  );
};

/** Opens a Pi session with the selected model and its repository tools. */
export class PiSdk extends Context.Service<
  PiSdk,
  { readonly start: (options: PiStartOptions) => Promise<PiStartResult> }
>()("@usine/agents/pi/PiSdk") {}

export const piSdkLive = Layer.succeed(PiSdk)({
  start: async (options) => {
    const modelRuntime = await ModelRuntime.create({ signal: options.signal });
    const parts = splitPiModel(options.model);
    if (parts === undefined) return { _tag: "UnknownModel" };
    const selected = modelRuntime.getModel(parts.provider, parts.modelId);
    if (selected === undefined) return { _tag: "UnknownModel" };
    const agentDir = getAgentDir();
    // The worktree is repository-controlled input, so its `.pi/` settings,
    // SYSTEM.md, extensions, and skills never load. Inline extension
    // factories, such as the pause gate, register regardless.
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
    const sessionOptions = {
      cwd: options.cwd,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager,
      thinkingLevel: options.thinkingLevel,
    } as const;
    // A custom tool replaces the built-in tool of the same name.
    const environmentScopedSessionOptions = Option.match(options.environment, {
      onNone: () => sessionOptions,
      onSome: (environment) => ({
        ...sessionOptions,
        customTools: [environmentBashTool(options.cwd, environment)],
      }),
    });
    const { session } = await createAgentSession({
      ...environmentScopedSessionOptions,
      model: selected,
    });
    let ownershipTransferred = false;
    try {
      const active = session.model;
      if (active === undefined) throw new Error("Pi started without an active model");
      const model = ModelId.make(`${active.provider}/${active.id}`);
      const supported = supportedThinkingLevels(active);
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
      };
    } finally {
      if (!ownershipTransferred) session.dispose();
    }
  },
});

export interface AcquiredPiStart {
  readonly result: PiStartResult;
  /** Safe to call twice: failed setup and the ambient scope may both request cleanup. */
  readonly dispose: () => void;
}

/**
 * Runs SDK startup so an interruption cannot leak a session. A result that
 * loses the race with interruption is disposed in its Promise continuation;
 * one already handed to `use` is disposed by `onExit`.
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
