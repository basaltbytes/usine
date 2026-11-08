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
  AnthropicApiKey,
  AnthropicProvider,
  AnthropicSubscriptionToken,
  ChatGptLogin,
  HostFilePath,
  OpenAiApiKey,
  OpenAiProvider,
  credentialKind,
  configuredProvider,
  type LlmProviders,
  type LlmProviderName,
} from "../llm/llm.ts";
import { SettingsInForce } from "../settings.ts";
import { UpstreamBase } from "../upstream.ts";
import {
  credentialProvider,
  ProviderCredentialError,
  type ProviderCredential,
  type ProviderConnection,
} from "./model.ts";

const Snapshot = Schema.Struct({
  "anthropic-messages": Schema.optionalKey(Schema.Option(AnthropicProvider)),
  "openai-responses": Schema.optionalKey(Schema.Option(OpenAiProvider)),
});
const SnapshotJson = Schema.fromJsonString(Schema.toCodecJson(Snapshot));
type Snapshot = typeof Snapshot.Type;
const failed = (cause: { readonly _tag: string }) =>
  ProviderCredentialError.make({
    message: `Could not read or save provider credentials (${cause._tag}). Check the credential directory permissions.`,
  });

export class ProviderCredentials extends Context.Service<
  ProviderCredentials,
  {
    readonly status: Effect.Effect<readonly ProviderConnection[], ProviderCredentialError>;
    readonly replace: (
      credential: ProviderCredential,
    ) => Effect.Effect<void, ProviderCredentialError>;
    readonly disconnect: (
      provider: LlmProviderName,
    ) => Effect.Effect<void, ProviderCredentialError>;
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
          snapshot = yield* fs
            .readFileString(file)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(SnapshotJson)),
              Effect.mapError(failed),
            );
        }
        const apply = (providers: LlmProviders) =>
          Effect.succeed({
            "anthropic-messages": snapshot["anthropic-messages"] ?? providers["anthropic-messages"],
            "openai-responses": snapshot["openai-responses"] ?? providers["openai-responses"],
          });
        const initial = yield* settings.current;
        yield* settings.replace({ ...initial, providers: yield* apply(initial.providers) });
        const save = Effect.fn("ProviderCredentials.save")(function* (
          next: Snapshot,
          provider: LlmProviderName,
        ) {
          yield* Effect.annotateCurrentSpan({ provider });
          const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
          const temporary = `${file}.${uuid}`;
          const text = yield* Schema.encodeEffect(SnapshotJson)(next).pipe(Effect.orDie);
          yield* fs
            .makeDirectory(directory, { recursive: true, mode: 0o700 })
            .pipe(
              Effect.andThen(fs.writeFileString(temporary, text, { mode: 0o600, flag: "wx" })),
              Effect.andThen(fs.rename(temporary, file)),
              Effect.mapError(failed),
            );
          const previous = snapshot["openai-responses"];
          snapshot = next;
          const current = yield* settings.current;
          yield* settings.replace({ ...current, providers: yield* apply(current.providers) });
          if (
            provider === "openai-responses" &&
            previous !== undefined &&
            Option.isSome(previous) &&
            previous.value.credential._tag === "ChatGptLogin"
          ) {
            yield* fs
              .remove(previous.value.credential.authFile, { force: true })
              .pipe(Effect.mapError(failed));
          }
          yield* Effect.logInfo("Provider credential updated", {
            provider,
            connected:
              provider === "anthropic-messages"
                ? Option.isSome(next["anthropic-messages"] ?? Option.none())
                : Option.isSome(next["openai-responses"] ?? Option.none()),
          });
        }, Effect.uninterruptible);
        return {
          apply,
          status: Effect.gen(function* () {
            const { providers } = yield* settings.current;
            return yield* Effect.forEach(
              ["anthropic-messages", "openai-responses"] as const,
              (provider) =>
                Effect.gen(function* () {
                  const held = configuredProvider(providers, provider);
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
                if (provider === "anthropic-messages") {
                  const held = AnthropicProvider.make({
                    upstream: UpstreamBase.make("https://api.anthropic.com"),
                    credential:
                      credential.kind === "claude-subscription"
                        ? AnthropicSubscriptionToken.make({ token: credential.secret })
                        : AnthropicApiKey.make({ key: credential.secret }),
                  });
                  return yield* save(
                    { ...snapshot, "anthropic-messages": Option.some(held) },
                    provider,
                  );
                }
                const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
                let held: OpenAiProvider;
                if (credential.kind === "chatgpt-subscription") {
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
                  held = OpenAiProvider.make({
                    upstream: UpstreamBase.make("https://chatgpt.com/backend-api/codex"),
                    credential: login,
                  });
                } else {
                  held = OpenAiProvider.make({
                    upstream: UpstreamBase.make("https://api.openai.com"),
                    credential: OpenAiApiKey.make({ key: credential.secret }),
                  });
                }
                yield* save({ ...snapshot, "openai-responses": Option.some(held) }, provider);
              }),
            ),
          ),
          disconnect: Effect.fn("ProviderCredentials.disconnect")((provider: LlmProviderName) =>
            lock.withPermit(
              Effect.suspend(() => save({ ...snapshot, [provider]: Option.none() }, provider)),
            ),
          ),
        };
      }),
    );
}
