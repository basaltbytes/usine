import { selectProvider } from "@usine/core/agent/provider";
import { Context, Crypto, Effect, Fiber, Layer, Redacted, Semaphore } from "effect";
import {
  type LoginProvider,
  type ProviderLoginView,
  ProviderCredentialError,
  type ProviderStatus,
  StaticKey,
} from "@usine/gateway/credentials";
import { listedSelectors } from "./api.ts";
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
    /** Connects `key` for the provider of `target` that `provider` names: its slot, ID, or login. */
    readonly apiKey: (
      target: string,
      provider: string,
      key: Redacted.Redacted<string>,
    ) => Effect.Effect<void, ProviderCredentialError>;
    /** Disconnects the provider of `target` that `provider` names: its slot, ID, or login. */
    readonly disconnect: (
      target: string,
      provider: string,
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
      /** Returns the provider among `providers` of the destination `label` that `name` selects. */
      const selecting = <A extends Parameters<typeof listedSelectors>[0]>(
        label: string,
        providers: ReadonlyArray<A>,
        name: string,
      ) =>
        Effect.fromOption(selectProvider(providers, name, listedSelectors)).pipe(
          Effect.mapError(() =>
            ProviderCredentialError.make({
              message: `${label} has no provider ${name}. Choose ${providers.map(({ id }) => id).join(", ")}.`,
            }),
          ),
        );
      /**
       * Returns the provider of `target` that `name` selects, without reading its credential, so a
       * key or a disconnect can replace a credential that the destination can't read.
       */
      const resolved = Effect.fn("ProviderLogins.resolved")(function* (
        target: string,
        name: string,
      ) {
        yield* Effect.annotateCurrentSpan({ target, provider: name });
        const { label, providers } = yield* targets.providers(target);
        return yield* selecting(label, providers, name);
      });
      /** Returns the provider of `target` that `name` selects, if the destination can read its status. */
      const listed = Effect.fn("ProviderLogins.listed")(function* (target: string, name: string) {
        const { label, providers } = yield* targets.get(target);
        const connection = yield* selecting(label, providers, name);
        if ("error" in connection)
          return yield* ProviderCredentialError.make({ message: connection.error });
        return connection;
      });
      const stop = Effect.fn("ProviderLogins.cancel")(function* (session: Session) {
        const { provider, target, id } = session.view;
        yield* Effect.annotateCurrentSpan({ provider, target, loginId: id });
        session.view = { ...session.view, state: { status: "cancelled" } };
        yield* Fiber.interrupt(session.fiber);
        session.process = undefined;
        yield* Effect.logInfo("Provider login cancelled", { provider, target, loginId: id });
      });
      /** Stops the pending sign-in with `login` on `target`, if any. */
      const stopLogin = (target: string, login: LoginProvider | null) =>
        Effect.forEach(
          [...sessions.values()].filter(
            (session) =>
              session.view.target === target && session.view.provider === login && active(session),
          ),
          stop,
          { discard: true },
        );
      return {
        status: Effect.map(targets.list, (destinations) => ({
          targets: destinations,
          logins: [...sessions.values()].map(({ view }) => view),
        })).pipe(Effect.withSpan("ProviderLogins.status")),
        begin: Effect.fn("ProviderLogins.begin")((target: string, provider: LoginProvider) =>
          lock.withPermit(
            Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({ target, provider });
              yield* listed(target, provider);
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
          (target: string, provider: string, key: Redacted.Redacted<string>) =>
            lock.withPermit(
              Effect.gen(function* () {
                const connection = yield* resolved(target, provider);
                if (!connection.accepts.apiKey)
                  return yield* ProviderCredentialError.make({
                    message: `${connection.label} doesn't take an API key on this destination.`,
                  });
                yield* stopLogin(target, connection.accepts.login);
                yield* targets.replace(
                  target,
                  StaticKey.make({ provider: connection.id, secret: key }),
                );
              }),
            ),
        ),
        disconnect: Effect.fn("ProviderLogins.disconnect")((target: string, provider: string) =>
          lock.withPermit(
            Effect.gen(function* () {
              const connection = yield* resolved(target, provider);
              yield* stopLogin(target, connection.accepts.login);
              yield* targets.disconnect(target, connection.provider);
            }),
          ),
        ),
      };
    }),
  );
}
