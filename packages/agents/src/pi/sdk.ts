import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Agent } from "@usine/core";
import { Context, Effect, Exit, Layer, Option } from "effect";
import {
  type PiAuthentication,
  type PiPool,
  requiredPiPool,
  resolvePiPool,
} from "./authentication.ts";

export type PiSessionEvent = AgentSessionEvent;
export type PiMessage = Awaited<
  ReturnType<typeof createAgentSession>
>["session"]["messages"][number];

/** Narrow in-process Pi session surface consumed by the adapter. */
export interface PiSession {
  readonly messages: ReadonlyArray<PiMessage>;
  readonly subscribe: (listener: (event: PiSessionEvent) => void) => () => void;
  readonly prompt: (prompt: string) => Promise<void>;
  readonly steer: (message: string) => Promise<void>;
  readonly abort: () => Promise<void>;
  readonly dispose: () => void;
}

export interface PiStartOptions {
  readonly cwd: string;
  readonly extensions: ReadonlyArray<InlineExtension>;
  readonly model: Option.Option<Agent.ModelId>;
  readonly signal: AbortSignal;
  readonly thinkingLevel: Agent.Effort;
}

export type PiStartResult =
  | {
      readonly _tag: "AuthenticationUnavailable";
      readonly model: Agent.ModelId;
      readonly requiredPool: PiPool;
    }
  | {
      readonly _tag: "UnsupportedAuthentication";
      readonly authentication: Extract<PiAuthentication, { readonly _tag: "OAuth" }>;
      readonly model: Agent.ModelId;
      readonly requiredPool: PiPool;
    }
  | { readonly _tag: "UnknownModel" }
  | {
      readonly _tag: "Started";
      readonly model: Agent.ModelId;
      readonly pool: PiPool;
      readonly session: PiSession;
    };

/** The parent orchestrates through usine extensions; harnesses own repository tools. */
export const piParentSessionToolPolicy = { noTools: "builtin" } as const;

/** Narrow SDK seam keeps vendor setup testable without module replacement. */
export class PiSdk extends Context.Service<
  PiSdk,
  { readonly start: (options: PiStartOptions) => Promise<PiStartResult> }
>()("@usine/agents/pi/PiSdk") {}

const splitModel = (model: Agent.ModelId): readonly [string, string] | undefined => {
  const separator = model.indexOf("/");
  return separator <= 0 || separator === model.length - 1
    ? undefined
    : [model.slice(0, separator), model.slice(separator + 1)];
};

export const piSdkLive = Layer.succeed(PiSdk)({
  start: async (options) => {
    const modelRuntime = await ModelRuntime.create({ signal: options.signal });
    let selected: ReturnType<ModelRuntime["getModel"]>;
    if (Option.isSome(options.model)) {
      const parts = splitModel(options.model.value);
      if (parts === undefined) return { _tag: "UnknownModel" };
      selected = modelRuntime.getModel(parts[0], parts[1]);
      if (selected === undefined) return { _tag: "UnknownModel" };
    }
    const agentDir = getAgentDir();
    // The Attempt worktree is repository-controlled input: never trust its
    // `.pi/` settings, SYSTEM.md, extensions, or skills. The subagents tool
    // arrives as an inline factory, which the loader registers regardless.
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
      ...piParentSessionToolPolicy,
      resourceLoader,
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager,
      thinkingLevel: options.thinkingLevel,
    } as const;
    const { session } =
      selected === undefined
        ? await createAgentSession(sessionOptions)
        : await createAgentSession({ ...sessionOptions, model: selected });
    let ownershipTransferred = false;
    try {
      const active = session.model;
      if (active === undefined) throw new Error("Pi started without an active model");
      const model = Agent.ModelId.make(`${active.provider}/${active.id}`);
      const resolvedAuthentication = await modelRuntime.checkAuth(active.provider, {
        signal: options.signal,
      });
      const authentication: PiAuthentication | undefined =
        resolvedAuthentication?.type === "api_key"
          ? { _tag: "ApiKey" }
          : resolvedAuthentication?.type === "oauth"
            ? {
                _tag: "OAuth",
                subscription:
                  modelRuntime.getProvider(active.provider)?.auth.oauth?.isSubscription === true,
              }
            : undefined;
      const requiredPool = requiredPiPool(active.provider);
      const pool = resolvePiPool(active.provider, authentication);
      if (authentication === undefined) {
        return { _tag: "AuthenticationUnavailable", model, requiredPool };
      }
      if (pool === undefined && authentication._tag === "OAuth") {
        return {
          _tag: "UnsupportedAuthentication",
          authentication,
          model,
          requiredPool,
        };
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
  /** Idempotent because both failed setup and the ambient scope may request cleanup. */
  readonly dispose: () => void;
}

/**
 * Keeps SDK startup interruptible while retaining ownership until setup succeeds.
 * A result that loses the race with interruption is disposed in its Promise
 * continuation; a result already handed to `use` is disposed by `onExit`.
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
