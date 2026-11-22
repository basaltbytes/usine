import {
  anthropic,
  type GatewaySlot,
  modelProviders,
  UpstreamBase,
} from "@usine/core/agent/provider";
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
import { SettingsInForce } from "../settings.ts";
import {
  credentialProvider,
  ProviderCredentialError,
  type ProviderCredential,
  type ProviderConnection,
} from "./model.ts";

const Secret = Schema.Redacted(Schema.NonEmptyString);

/**
 * A managed credential as `provider-credentials.json` stores it, in the format of gateways from
 * before the provider catalog, so that an older gateway reads the file too.
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

/** Each managed slot's credential, or `None` for a slot disconnected from the environment's credential. */
const SnapshotJson = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Record(Schema.String, Schema.Option(Stored))),
);
type Snapshot = Readonly<Record<string, Option.Option<LlmProvider>>>;

const fromStored = ({ upstream, credential }: Stored): LlmProvider =>
  LlmProvider.make({
    upstream: Option.some(upstream),
    credential:
      credential._tag === "AnthropicApiKey" || credential._tag === "OpenAiApiKey"
        ? ApiKey.make({ key: credential.key })
        : credential,
  });

const toStored = (slot: string, held: LlmProvider): Stored => {
  const { credential } = held;
  const upstream = Option.getOrElse(held.upstream, () =>
    // SAFETY: the store holds only slots that `credentialProvider` returns, which `modelProviders` has.
    Option.getOrThrow(
      Option.map(modelProviders.find(slot), ({ protocols }) => protocols[0].upstream),
    ),
  );
  if (credential._tag === "AnthropicSubscriptionToken")
    return { _tag: "AnthropicProvider", upstream, credential };
  if (credential._tag === "ChatGptLogin") return { _tag: "OpenAiProvider", upstream, credential };
  return slot === anthropic.slot
    ? {
        _tag: "AnthropicProvider",
        upstream,
        credential: { _tag: "AnthropicApiKey", key: credential.key },
      }
    : {
        _tag: "OpenAiProvider",
        upstream,
        credential: { _tag: "OpenAiApiKey", key: credential.key },
      };
};

const failed = (cause: { readonly _tag: string }) =>
  ProviderCredentialError.make({
    message: `Could not read or save provider credentials (${cause._tag}). Check the credential directory permissions.`,
  });

/**
 * The provider credentials that usine connects through the admin API, for the subscription logins
 * and API keys of `modelProviders`. They replace the environment's credentials across reloads and
 * restarts.
 */
export class ProviderCredentials extends Context.Service<
  ProviderCredentials,
  {
    readonly status: Effect.Effect<readonly ProviderConnection[], ProviderCredentialError>;
    readonly replace: (
      credential: ProviderCredential,
    ) => Effect.Effect<void, ProviderCredentialError>;
    readonly disconnect: (provider: GatewaySlot) => Effect.Effect<void, ProviderCredentialError>;
    readonly apply: (providers: LlmProviders) => Effect.Effect<LlmProviders>;
  }
>()("@usine/gateway/credentials/store/ProviderCredentials") {
  static readonly layer = (directory: string) =>
    Layer.effect(
      ProviderCredentials,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const crypto = yield* Crypto.Crypto;
        const settings = yield* SettingsInForce;
        const logins = yield* ChatGptLogins;
        const lock = yield* Semaphore.make(1);
        const file = `${directory}/provider-credentials.json`;
        let snapshot: Snapshot = {};
        if (yield* fs.exists(file).pipe(Effect.mapError(failed))) {
          const stored = yield* fs
            .readFileString(file)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(SnapshotJson)),
              Effect.mapError(failed),
            );
          snapshot = Object.fromEntries(
            Object.entries(stored).map(([slot, held]) => [slot, Option.map(held, fromStored)]),
          );
        }
        const apply = (providers: LlmProviders) =>
          Effect.succeed(
            Object.entries(snapshot).reduce<LlmProviders>(
              (applied, [slot, held]) =>
                Option.match(held, {
                  onNone: () =>
                    Object.fromEntries(Object.entries(applied).filter(([name]) => name !== slot)),
                  onSome: (value) => ({ ...applied, [slot]: value }),
                }),
              providers,
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
          const stored = Object.fromEntries(
            Object.entries(next).map(([slot, held]) => [
              slot,
              Option.map(held, (value) => toStored(slot, value)),
            ]),
          );
          const text = yield* Schema.encodeEffect(SnapshotJson)(stored).pipe(Effect.orDie);
          yield* fs
            .makeDirectory(directory, { recursive: true, mode: 0o700 })
            .pipe(
              Effect.andThen(fs.writeFileString(temporary, text, { mode: 0o600, flag: "wx" })),
              Effect.andThen(fs.rename(temporary, file)),
              Effect.mapError(failed),
            );
          const previous = Option.flatten(Option.fromUndefinedOr(snapshot[provider]));
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
            connected: Option.isSome(Option.flatten(Option.fromUndefinedOr(next[provider]))),
          });
        }, Effect.uninterruptible);
        /** Returns the credential that `credential` connects; a ChatGPT login is written to its own auth file first. */
        const heldCredential = (credential: ProviderCredential) =>
          Effect.gen(function* () {
            switch (credential.kind) {
              case "anthropic-api-key":
              case "openai-api-key":
                return LlmProvider.make({
                  upstream: Option.none(),
                  credential: ApiKey.make({ key: credential.secret }),
                });
              case "claude-subscription":
                return LlmProvider.make({
                  upstream: Option.none(),
                  credential: AnthropicSubscriptionToken.make({ token: credential.secret }),
                });
              case "chatgpt-subscription": {
                const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
                const authFile = HostFilePath.make(`${directory}/codex-${uuid}.json`);
                yield* Effect.fromResult(
                  tokensFromAuthFile(authFile, Redacted.value(credential.secret)),
                ).pipe(Effect.mapError(failed));
                yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
                  Effect.andThen(
                    fs.writeFileString(authFile, Redacted.value(credential.secret), {
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
                const login = ChatGptLogin.make({
                  authFile,
                  tokenUrl: UpstreamBase.make(CHATGPT_TOKEN_URL),
                });
                yield* logins.reload(login).pipe(Effect.mapError(failed));
                return LlmProvider.make({
                  upstream: Option.some(CHATGPT_UPSTREAM),
                  credential: login,
                });
              }
            }
          });
        return {
          apply,
          status: Effect.gen(function* () {
            const { providers } = yield* settings.current;
            return yield* Effect.forEach(modelProviders.slots, (provider) =>
              Effect.gen(function* () {
                const held = Option.fromUndefinedOr(providers[provider]);
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
                  provider,
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
                const provider = credentialProvider(credential);
                yield* Effect.annotateCurrentSpan({ provider, kind: credential.kind });
                const held = yield* heldCredential(credential);
                yield* save({ ...snapshot, [provider]: Option.some(held) }, provider);
              }),
            ),
          ),
          disconnect: Effect.fn("ProviderCredentials.disconnect")((provider: GatewaySlot) =>
            lock.withPermit(
              Effect.suspend(() => save({ ...snapshot, [provider]: Option.none() }, provider)),
            ),
          ),
        };
      }),
    );
}
