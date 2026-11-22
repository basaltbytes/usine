import { anthropic, GatewaySlot, openai, UpstreamBase } from "@usine/core/agent/provider";
import {
  Context,
  Crypto,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
  Semaphore,
} from "effect";
import { ChatGptLogins, CHATGPT_TOKEN_URL } from "../chatgpt/logins.ts";
import { readAuthFile, tokensFromAuthFile } from "../chatgpt/auth-file.ts";
import {
  AnthropicSubscriptionToken,
  ApiKey,
  CHATGPT_UPSTREAM,
  ChatGptLogin,
  credentialKind,
  HostFilePath,
  LlmProvider,
  type LlmProviders,
} from "../llm/llm.ts";
import { GatewaySettings, SettingsInForce } from "../settings.ts";
import {
  type LoginSecret,
  ProviderCredentialError,
  type ProviderCredential,
  type ProviderConnection,
  providerEntry,
  UnservedProvider,
} from "./model.ts";

const Secret = Schema.Redacted(Schema.NonEmptyString);

/**
 * A credential in the format of gateways up to 0.3.0, which they read: a subscription login, or the
 * API key of a built-in provider.
 */
const Stored = Schema.Union([
  Schema.TaggedStruct("AnthropicProvider", {
    upstream: UpstreamBase,
    credential: Schema.Union([
      Schema.TaggedStruct("AnthropicApiKey", { key: Secret }),
      AnthropicSubscriptionToken,
    ]),
  }),
  Schema.TaggedStruct("OpenAiProvider", {
    upstream: UpstreamBase,
    credential: Schema.Union([Schema.TaggedStruct("OpenAiApiKey", { key: Secret }), ChatGptLogin]),
  }),
]);
type Stored = typeof Stored.Type;

/**
 * Returns the entry of a static key for `slot` in the format of gateways up to 0.3.0, which has one
 * for the built-in providers' slots only.
 */
const storedKey = (slot: GatewaySlot, key: Redacted.Redacted<string>): Option.Option<Stored> =>
  slot === anthropic.slot
    ? Option.some({
        _tag: "AnthropicProvider",
        upstream: anthropic.protocols[0].upstream,
        credential: { _tag: "AnthropicApiKey", key },
      })
    : slot === openai.slot
      ? Option.some({
          _tag: "OpenAiProvider",
          upstream: openai.protocols[0].upstream,
          credential: { _tag: "OpenAiApiKey", key },
        })
      : Option.none();

/**
 * `provider-credentials.json`: by slot, a credential that the format of gateways up to 0.3.0
 * stores, or `None` for a slot disconnected from the environment's credential; and in
 * `staticKeys`, the static key of each other slot. `staticKeys` isn't a slot, so those gateways
 * ignore it.
 */
const SnapshotJson = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.StructWithRest(
      Schema.Struct({ staticKeys: Schema.optionalKey(Schema.Record(GatewaySlot, Secret)) }),
      [Schema.Record(GatewaySlot, Schema.Option(Stored))],
    ),
  ),
);

/** The connected credentials: `stored` in the format of gateways up to 0.3.0, and the other static keys. */
interface Snapshot {
  readonly stored: Readonly<Record<GatewaySlot, Option.Option<Stored>>>;
  readonly staticKeys: Readonly<Record<GatewaySlot, Redacted.Redacted<string>>>;
}

const fromStored = ({ upstream, credential }: Stored): LlmProvider =>
  LlmProvider.make({
    upstream: Option.some(upstream),
    credential:
      credential._tag === "AnthropicApiKey" || credential._tag === "OpenAiApiKey"
        ? ApiKey.make({ key: credential.key })
        : credential,
  });

/** Returns `record` without `slot`. */
const without = <A>(record: Readonly<Record<GatewaySlot, A>>, slot: string) =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== slot));

/** Returns `snapshot` with `slot` holding `held`, a credential in the stored format or `None`. */
const storing = (snapshot: Snapshot, slot: GatewaySlot, held: Option.Option<Stored>): Snapshot => ({
  stored: { ...snapshot.stored, [slot]: held },
  staticKeys: without(snapshot.staticKeys, slot),
});

/** Returns `snapshot` with `slot` holding the static key `key`. */
const keying = (
  snapshot: Snapshot,
  slot: GatewaySlot,
  key: Redacted.Redacted<string>,
): Snapshot => ({
  stored: without(snapshot.stored, slot),
  staticKeys: { ...snapshot.staticKeys, [slot]: key },
});

const failed = (cause: { readonly _tag: string }) =>
  ProviderCredentialError.make({
    message: `Could not read or save provider credentials (${cause._tag}). Check the credential directory permissions.`,
  });

/**
 * The provider credentials that usine connects through the admin API: a static key for each
 * provider of the gateway's catalog that accepts one, and the subscription logins. They replace
 * the environment's credentials across reloads and restarts.
 */
export class ProviderCredentials extends Context.Service<
  ProviderCredentials,
  {
    readonly status: Effect.Effect<readonly ProviderConnection[], ProviderCredentialError>;
    readonly replace: (
      credential: ProviderCredential,
    ) => Effect.Effect<void, ProviderCredentialError | UnservedProvider>;
    /** Disconnects the provider whose slot or ID is `provider`. */
    readonly disconnect: (
      provider: string,
    ) => Effect.Effect<void, ProviderCredentialError | UnservedProvider>;
    readonly apply: (providers: LlmProviders) => Effect.Effect<LlmProviders>;
  }
>()("@usine/gateway/credentials/store/ProviderCredentials") {
  static readonly layer = (directory: string) =>
    Layer.effect(
      ProviderCredentials,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const crypto = yield* Crypto.Crypto;
        const { catalog } = yield* GatewaySettings;
        const settings = yield* SettingsInForce;
        const logins = yield* ChatGptLogins;
        const lock = yield* Semaphore.make(1);
        const file = `${directory}/provider-credentials.json`;
        let snapshot: Snapshot = { stored: {}, staticKeys: {} };
        if (yield* fs.exists(file).pipe(Effect.mapError(failed))) {
          const { staticKeys = {}, ...stored } = yield* fs
            .readFileString(file)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(SnapshotJson)),
              Effect.mapError(failed),
            );
          snapshot = { stored, staticKeys };
        }
        const apply = (providers: LlmProviders) =>
          Effect.succeed(
            Object.entries(snapshot.staticKeys).reduce<LlmProviders>(
              (applied, [slot, key]) => ({
                ...applied,
                [slot]: LlmProvider.make({
                  upstream: Option.none(),
                  credential: ApiKey.make({ key }),
                }),
              }),
              Object.entries(snapshot.stored).reduce<LlmProviders>(
                (applied, [slot, held]) =>
                  Option.match(held, {
                    onNone: () => without(applied, slot),
                    onSome: (value) => ({ ...applied, [slot]: fromStored(value) }),
                  }),
                providers,
              ),
            ),
          );
        const initial = yield* settings.current;
        yield* settings.replace({ ...initial, providers: yield* apply(initial.providers) });
        const save = Effect.fn("ProviderCredentials.save")(function* (
          next: Snapshot,
          provider: GatewaySlot,
        ) {
          yield* Effect.annotateCurrentSpan({ provider });
          const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
          const temporary = `${file}.${uuid}`;
          const text = yield* Schema.encodeEffect(SnapshotJson)({
            ...next.stored,
            staticKeys: next.staticKeys,
          }).pipe(Effect.orDie);
          yield* fs
            .makeDirectory(directory, { recursive: true, mode: 0o700 })
            .pipe(
              Effect.andThen(fs.writeFileString(temporary, text, { mode: 0o600, flag: "wx" })),
              Effect.andThen(fs.rename(temporary, file)),
              Effect.mapError(failed),
            );
          const previous = Option.flatten(Option.fromUndefinedOr(snapshot.stored[provider]));
          snapshot = next;
          const current = yield* settings.current;
          yield* settings.replace({ ...current, providers: yield* apply(current.providers) });
          if (Option.isSome(previous) && previous.value.credential._tag === "ChatGptLogin") {
            yield* fs
              .remove(previous.value.credential.authFile, { force: true })
              .pipe(Effect.mapError(failed));
          }
          yield* Effect.logInfo("Provider credential updated", {
            provider,
            connected:
              Option.isSome(Option.flatten(Option.fromUndefinedOr(next.stored[provider]))) ||
              provider in next.staticKeys,
          });
        }, Effect.uninterruptible);
        /** Returns the stored credential of a login; a ChatGPT login is written to its own auth file first. */
        const heldLogin = ({ login, secret }: LoginSecret) =>
          Effect.gen(function* () {
            switch (login) {
              case "claude":
                return {
                  _tag: "AnthropicProvider",
                  upstream: anthropic.protocols[0].upstream,
                  credential: AnthropicSubscriptionToken.make({ token: secret }),
                } satisfies Stored;
              case "chatgpt": {
                const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
                const authFile = HostFilePath.make(`${directory}/codex-${uuid}.json`);
                yield* Effect.fromResult(tokensFromAuthFile(authFile, Redacted.value(secret))).pipe(
                  Effect.mapError(failed),
                );
                yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
                  Effect.andThen(
                    fs.writeFileString(authFile, Redacted.value(secret), {
                      mode: 0o600,
                      flag: "wx",
                    }),
                  ),
                  Effect.mapError(failed),
                );
                yield* readAuthFile(authFile).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.mapError(() =>
                    ProviderCredentialError.make({
                      message: "Expected a Codex ChatGPT login with access and refresh tokens.",
                    }),
                  ),
                );
                const chatGpt = ChatGptLogin.make({
                  authFile,
                  tokenUrl: UpstreamBase.make(CHATGPT_TOKEN_URL),
                });
                yield* logins.reload(chatGpt).pipe(Effect.mapError(failed));
                return {
                  _tag: "OpenAiProvider",
                  upstream: CHATGPT_UPSTREAM,
                  credential: chatGpt,
                } satisfies Stored;
              }
            }
          });
        const unserved = (provider: string, message: string) =>
          UnservedProvider.make({
            provider,
            message: `${message} Install the @usine/gateway release that matches the orchestrator.`,
          });
        return {
          apply,
          status: Effect.gen(function* () {
            const { providers } = yield* settings.current;
            return yield* Effect.forEach(catalog.providers, (provider) =>
              Effect.gen(function* () {
                const held = Option.fromUndefinedOr(providers[provider.slot]);
                const credential = Option.map(held, (value) => value.credential);
                let expiresAt: string | null = null;
                let lastRefresh: string | null = null;
                if (Option.isSome(credential) && credential.value._tag === "ChatGptLogin") {
                  const tokens = yield* readAuthFile(credential.value.authFile).pipe(
                    Effect.provideService(FileSystem.FileSystem, fs),
                    Effect.mapError(failed),
                  );
                  expiresAt = Option.getOrNull(Option.map(tokens.expiresAt, DateTime.formatIso));
                  lastRefresh = Option.getOrNull(
                    Option.map(tokens.lastRefresh, DateTime.formatIso),
                  );
                }
                return {
                  provider: provider.slot,
                  ...providerEntry(provider),
                  credential: Option.getOrNull(Option.map(held, credentialKind)),
                  expiresAt,
                  lastRefresh,
                  refreshable:
                    Option.isSome(credential) && credential.value._tag === "ChatGptLogin",
                };
              }),
            );
          }).pipe(Effect.withSpan("ProviderCredentials.status")),
          replace: Effect.fn("ProviderCredentials.replace")((credential: ProviderCredential) =>
            lock.withPermit(
              Effect.gen(function* () {
                const named =
                  credential._tag === "StaticKey" ? credential.provider : credential.login;
                yield* Effect.annotateCurrentSpan({ credential: credential._tag, named });
                const provider = yield* Option.match(credential.providerIn(catalog), {
                  onNone: () =>
                    unserved(
                      named,
                      credential._tag === "StaticKey"
                        ? `The gateway serves no provider ${named} that accepts a static key.`
                        : `The gateway serves no provider that signs in with ${named}.`,
                    ),
                  onSome: Effect.succeed,
                });
                yield* Effect.annotateCurrentSpan({ provider: provider.slot });
                const next = yield* credential._tag === "LoginSecret"
                  ? Effect.map(heldLogin(credential), (held) =>
                      storing(snapshot, provider.slot, Option.some(held)),
                    )
                  : Effect.succeed(
                      Option.match(storedKey(provider.slot, credential.secret), {
                        onNone: () => keying(snapshot, provider.slot, credential.secret),
                        onSome: (stored) => storing(snapshot, provider.slot, Option.some(stored)),
                      }),
                    );
                yield* save(next, provider.slot);
              }),
            ),
          ),
          disconnect: Effect.fn("ProviderCredentials.disconnect")((name: string) =>
            lock.withPermit(
              Effect.gen(function* () {
                yield* Effect.annotateCurrentSpan({ named: name });
                const { slot } = yield* Option.match(catalog.find(name), {
                  onNone: () => unserved(name, `The gateway serves no provider ${name}.`),
                  onSome: Effect.succeed,
                });
                yield* save(storing(snapshot, slot, Option.none()), slot);
              }),
            ),
          ),
        };
      }),
    );
}
