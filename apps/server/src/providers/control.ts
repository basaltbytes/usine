import { Context, Crypto, Effect, Fiber, Layer, Redacted, Semaphore } from "effect";
import {
  type LoginProvider,
  type ProviderLoginView,
  ProviderCredentialError,
  type ProviderStatus,
} from "@usine/gateway/credentials";
import { ProviderTargets } from "./targets.ts";
import { ProviderLoginRunner, type LoginProcess } from "./runner.ts";

type Session = {
  view: ProviderLoginView;
  process: LoginProcess | undefined;
  fiber: Fiber.Fiber<void>;
};
export class ProviderLogins extends Context.Service<
  ProviderLogins,
  {
    readonly status: Effect.Effect<ProviderStatus, ProviderCredentialError>;
    readonly begin: (
      target: string,
      provider: LoginProvider,
    ) => Effect.Effect<ProviderLoginView, ProviderCredentialError>;
    readonly submit: (
      id: string,
      code: Redacted.Redacted<string>,
    ) => Effect.Effect<void, ProviderCredentialError>;
    readonly cancel: (id: string) => Effect.Effect<void, ProviderCredentialError>;
    readonly apiKey: (
      target: string,
      provider: LoginProvider,
      key: Redacted.Redacted<string>,
    ) => Effect.Effect<void, ProviderCredentialError>;
    readonly disconnect: (
      target: string,
      provider: LoginProvider,
    ) => Effect.Effect<void, ProviderCredentialError>;
  }
>()("@usine/server/providers/control/ProviderLogins") {
  static readonly layer = Layer.effect(
    ProviderLogins,
    Effect.gen(function* () {
      const targets = yield* ProviderTargets;
      const random = yield* Crypto.Crypto;
      const runner = yield* ProviderLoginRunner;
      const scope = yield* Effect.scope;
      const lock = yield* Semaphore.make(1);
      const sessions = new Map<string, Session>();
      const active = (session: Session) =>
        session.view.state.status === "starting" || session.view.state.status === "authorizing";
      const find = (id: string) =>
        Effect.fromNullishOr(sessions.get(id)).pipe(
          Effect.mapError(() =>
            ProviderCredentialError.make({
              message: "This login expired. Start a new connection.",
            }),
          ),
        );
      const stop = Effect.fn("ProviderLogins.cancel")(function* (session: Session) {
        const { provider, target, id } = session.view;
        yield* Effect.annotateCurrentSpan({ provider, target, loginId: id });
        session.view = { ...session.view, state: { status: "cancelled" } };
        yield* Fiber.interrupt(session.fiber);
        session.process = undefined;
        yield* Effect.logInfo("Provider login cancelled", { provider, target, loginId: id });
      });
      return {
        status: Effect.map(targets.list, (listed) => ({
          targets: listed,
          logins: [...sessions.values()].map(({ view }) => view),
        })).pipe(Effect.withSpan("ProviderLogins.status")),
        begin: Effect.fn("ProviderLogins.begin")((target: string, provider: LoginProvider) =>
          lock.withPermit(
            Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({ target, provider });
              yield* targets.get(target);
              for (const [id, session] of sessions) {
                if (session.view.target !== target || session.view.provider !== provider) continue;
                if (active(session)) {
                  yield* Effect.logInfo("Provider login already pending", {
                    target,
                    provider,
                    loginId: id,
                  });
                  return session.view;
                }
                sessions.delete(id);
              }
              const id = yield* random.randomUUIDv4().pipe(Effect.orDie);
              const view: ProviderLoginView = {
                id,
                target,
                provider,
                state: { status: "starting" },
              };
              const job = Effect.scoped(
                Effect.gen(function* () {
                  const process = yield* runner.start(provider);
                  const session = sessions.get(id);
                  if (session === undefined) return;
                  session.process = process;
                  const prompt = yield* process.prompt;
                  session.view = { ...view, state: { status: "authorizing", ...prompt } };
                  yield* Effect.logInfo("Provider login awaits authorization", {
                    target,
                    provider,
                    loginId: id,
                  });
                  const credential = yield* process.result;
                  yield* lock.withPermit(
                    Effect.gen(function* () {
                      if (!active(session)) return;
                      yield* targets.replace(target, credential);
                      session.process = undefined;
                      session.view = { ...view, state: { status: "connected" } };
                    }),
                  );
                  yield* Effect.logInfo("Provider login completed", {
                    target,
                    provider,
                    loginId: id,
                  });
                }),
              ).pipe(
                Effect.catchTag("ProviderCredentialError", (error) =>
                  Effect.gen(function* () {
                    const session = sessions.get(id);
                    if (session !== undefined) {
                      session.process = undefined;
                      session.view = {
                        ...view,
                        state: { status: "failed", message: error.message },
                      };
                    }
                    yield* Effect.logWarning("Provider login failed", {
                      target,
                      provider,
                      loginId: id,
                    });
                  }),
                ),
              );
              const fiber = yield* Effect.forkIn(Effect.yieldNow.pipe(Effect.andThen(job)), scope);
              sessions.set(id, { view, process: undefined, fiber });
              yield* Effect.logInfo("Provider login started", { target, provider, loginId: id });
              return view;
            }),
          ),
        ),
        submit: Effect.fn("ProviderLogins.submit")(function* (
          id: string,
          code: Redacted.Redacted<string>,
        ) {
          const session = yield* find(id);
          yield* Effect.annotateCurrentSpan({
            loginId: id,
            provider: session.view.provider,
            target: session.view.target,
          });
          if (
            session.view.provider !== "claude" ||
            session.process === undefined ||
            session.view.state.status !== "authorizing"
          )
            return yield* ProviderCredentialError.make({
              message: "This login is not waiting for a Claude code.",
            });
          yield* session.process.submit(code);
        }),
        cancel: Effect.fn("ProviderLogins.cancelById")((id: string) =>
          lock.withPermit(
            Effect.flatMap(find(id), (session) => (active(session) ? stop(session) : Effect.void)),
          ),
        ),
        apiKey: Effect.fn("ProviderLogins.apiKey")(
          (target: string, provider: LoginProvider, key: Redacted.Redacted<string>) =>
            lock.withPermit(
              Effect.gen(function* () {
                for (const session of sessions.values())
                  if (
                    session.view.target === target &&
                    session.view.provider === provider &&
                    active(session)
                  )
                    yield* stop(session);
                yield* targets.replace(target, {
                  kind: provider === "claude" ? "anthropic-api-key" : "openai-api-key",
                  secret: key,
                });
              }),
            ),
        ),
        disconnect: Effect.fn("ProviderLogins.disconnect")(
          (target: string, provider: LoginProvider) =>
            lock.withPermit(
              Effect.gen(function* () {
                for (const session of sessions.values())
                  if (
                    session.view.target === target &&
                    session.view.provider === provider &&
                    active(session)
                  )
                    yield* stop(session);
                yield* targets.disconnect(target, provider === "claude" ? "anthropic" : "openai");
              }),
            ),
        ),
      };
    }),
  );
}
