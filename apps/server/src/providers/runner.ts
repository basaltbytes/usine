/* eslint-disable no-control-regex -- Provider terminal output includes ANSI control sequences. */
import {
  Config,
  Context,
  Deferred,
  Effect,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Queue,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ProviderCredentialError, type ProviderCredential } from "@usine/gateway/credentials";

import type { LoginProvider } from "@usine/gateway/credentials";
export type LoginPrompt = { readonly url: string; readonly code: string | null };
export interface LoginProcess {
  readonly prompt: Effect.Effect<LoginPrompt, ProviderCredentialError>;
  readonly result: Effect.Effect<ProviderCredential, ProviderCredentialError>;
  readonly submit: (code: Redacted.Redacted<string>) => Effect.Effect<void>;
}
export class ProviderLoginRunner extends Context.Service<
  ProviderLoginRunner,
  {
    readonly start: (
      provider: LoginProvider,
    ) => Effect.Effect<LoginProcess, ProviderCredentialError, import("effect").Scope.Scope>;
  }
>()("@usine/server/providers/runner/ProviderLoginRunner") {}

const failure = () =>
  ProviderCredentialError.make({
    message: "Provider sign-in failed. Check that the pinned harness is installed and try again.",
  });
// macOS script rejects a socket as stdin, so cat feeds it through a pipe and stops when script exits.
const darwinClaudeLogin = [
  `sh -c 'echo $$ > "$0"; exec cat' "$1" 2>/dev/null | {`,
  '  script -q /dev/null sh -c "stty cols 1000; exec claude setup-token"',
  "  status=$?",
  '  while [ ! -s "$1" ]; do sleep 0.1; done',
  '  kill "$(cat "$1")"',
  '  exit "$status"',
  "}",
].join("\n");
const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/gu;
export const loginPrompt = (
  provider: LoginProvider,
  output: string,
): Option.Option<LoginPrompt> => {
  const text = output.replace(ansi, "");
  const url =
    provider === "claude"
      ? /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s\x07\x1b]+(?=[\s\x07\x1b])/u.exec(
          text,
        )?.[0]
      : /https:\/\/auth\.openai\.com\/codex\/device/u.exec(text)?.[0];
  const code =
    provider === "claude" ? null : (/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/u.exec(text)?.[0] ?? null);
  return url !== undefined && (provider === "claude" || code !== null)
    ? Option.some({ url, code })
    : Option.none();
};

export const providerLoginRunnerLayer = Layer.effect(
  ProviderLoginRunner,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Config.String("PATH").pipe(
      Config.withDefault("/usr/local/bin:/usr/bin:/bin"),
      Effect.orDie,
    );
    const home = yield* Config.String("HOME").pipe(Effect.orDie);
    return {
      start: Effect.fn("ProviderLoginRunner.start")(function* (provider: LoginProvider) {
        yield* Effect.annotateCurrentSpan({ provider });
        const directory = yield* fs
          .makeTempDirectoryScoped({ prefix: "usine-login-" })
          .pipe(Effect.mapError(failure));
        const input = yield* Queue.unbounded<Uint8Array>();
        const prompt = yield* Deferred.make<LoginPrompt, ProviderCredentialError>();
        const result = yield* Deferred.make<ProviderCredential, ProviderCredentialError>();
        const options = {
          env: {
            PATH: path,
            HOME: home,
            CODEX_HOME: directory,
            CLAUDE_CONFIG_DIR: directory,
            BROWSER: "true",
            TERM: "dumb",
            NO_COLOR: "1",
          },
          stdin: Stream.fromQueue(input),
        };
        const command =
          provider === "chatgpt"
            ? ChildProcess.make(
                "codex",
                ["-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"],
                options,
              )
            : process.platform === "darwin"
              ? ChildProcess.make(
                  "sh",
                  ["-c", darwinClaudeLogin, "sh", `${directory}/input.pid`],
                  options,
                )
              : ChildProcess.make(
                  "script",
                  ["-q", "-c", "stty cols 1000; claude setup-token", "/dev/null"],
                  options,
                );
        const processHandle = yield* spawner.spawn(command).pipe(Effect.mapError(failure));
        let output = "";
        const collect = Stream.merge(processHandle.stdout, processHandle.stderr).pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              output = (output + chunk).slice(-65536);
              const found = loginPrompt(provider, output);
              if (Option.isSome(found)) yield* Deferred.succeed(prompt, found.value);
            }),
          ),
        );
        const monitor = Effect.gen(function* () {
          const collector = yield* Effect.forkScoped(collect);
          const exit = yield* processHandle.exitCode;
          yield* Fiber.join(collector);
          if (Number(exit) !== 0) return yield* failure();
          if (provider === "claude") {
            const token = /sk-ant-oat01-[A-Za-z0-9_-]+/u.exec(output.replace(ansi, ""))?.[0];
            if (token === undefined) return yield* failure();
            yield* Deferred.succeed(result, {
              kind: "claude-subscription" as const,
              secret: Redacted.make(token),
            });
            return;
          }
          const auth = yield* fs.readFileString(`${directory}/auth.json`);
          yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                tokens: Schema.Struct({
                  access_token: Schema.NonEmptyString,
                  refresh_token: Schema.NonEmptyString,
                }),
              }),
            ),
          )(auth);
          yield* Deferred.succeed(result, {
            kind: "chatgpt-subscription" as const,
            secret: Redacted.make(auth),
          });
        }).pipe(
          Effect.scoped,
          Effect.timeout("15 minutes"),
          Effect.catch(() =>
            Effect.gen(function* () {
              yield* Effect.logWarning("Provider login failed or expired", { provider });
              yield* Deferred.fail(prompt, failure());
              yield* Deferred.fail(result, failure());
            }),
          ),
        );
        yield* Effect.forkScoped(monitor);
        return {
          prompt: Deferred.await(prompt),
          result: Deferred.await(result),
          submit: (code: Redacted.Redacted<string>) =>
            Queue.offer(input, new TextEncoder().encode(`${Redacted.value(code)}\n`)).pipe(
              Effect.asVoid,
            ),
        };
      }),
    };
  }),
);
