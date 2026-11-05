import { jsonKey } from "@usine/core/json-key";
import { NodeFileSystem } from "@effect/platform-node";
// The Node process boundary uses native process handles and synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFile, spawnSync } from "node:child_process";
// The Node server adapter requires native HTTP server and connection types.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, dirname, basename } from "node:path";
import { promisify } from "node:util";
import { assert, it } from "@effect/vitest";
import { GatewayDomain } from "@usine/core/worker";
import { Redacted, Effect, Config, Option, FileSystem } from "effect";
import { gatewayEnvironment, ghGatewayConfig } from "../../../src/ssh/gateway/environment.ts";

const run = promisify(execFile);
const ghOnPath = spawnSync("gh", ["--version"]).error === undefined;

it.live(
  "authenticates gh pagination and GitHub URLs through the Gateway socket",
  (context) =>
    Effect.gen(function* () {
      const actual1 = yield* Config.option(Config.String("PATH"));
      const environmentPATH1 = Option.getOrUndefined(actual1);
      context.skip(
        !ghOnPath,
        "gh is not on PATH; this test runs the real gh binary, version 2.83.2 or later",
      );
      // A short path fits the macOS Unix socket path limit. The socket serves only synthetic GitHub
      // responses.
      const directory = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.makeTempDirectory({
          directory: dirname("/tmp/usine-gh-"),
          prefix: basename("/tmp/usine-gh-"),
        }),
      );
      const socket = join(directory, "http.sock");
      const caller = "ugw1.test-claims.test-signature";
      const requests: Array<{ host: string | undefined; path: string | undefined }> = [];
      const server = createServer((request, response) => {
        requests.push({ host: request.headers.host, path: request.url });
        response.setHeader("Content-Type", "application/json");
        if (request.headers.authorization !== `token ${caller}`) {
          response.writeHead(401);
          response.end(
            jsonKey({
              message: "missing-caller-token",
            }),
          );
          return;
        }
        if (request.url === "/api/v3/repos/owner/repo/issues?per_page=1") {
          response.setHeader(
            "Link",
            '<https://api.github.com/repos/owner/repo/issues?per_page=1&page=2>; rel="next"',
          );
          response.end(jsonKey([{ number: 1 }]));
        } else if (request.url?.includes("page=2") === true) {
          response.end(jsonKey([{ number: 2 }]));
        } else {
          response.end(
            jsonKey({
              data: { repository: { issue: { title: "issues" }, pullRequest: { title: "pull" } } },
            }),
          );
        }
      });
      try {
        yield* Effect.callback<void>((resume) => {
          const resolve = (value: void) => resume(Effect.succeed(value));
          const reject = (error: Error) => resume(Effect.die(error));
          server.once("error", reject);
          server.listen(socket, resolve);
        });
        const domain = GatewayDomain.make("gw.test");
        for (const [name, content] of Object.entries(ghGatewayConfig(domain)))
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.writeFileString(
              join(directory, name),
              content.replace("/run/usine-gateway/http.sock", socket),
            ),
          );
        const { exported, sent } = gatewayEnvironment({
          domain,
          llmProviders: [],
          ghConfigDirectory: directory,
          homes: { codex: join(directory, "codex") },
          callerToken: Redacted.make(caller),
        });
        const env = {
          PATH: environmentPATH1,
          HOME: directory,
          GH_NO_UPDATE_NOTIFIER: "1",
          ...exported,
          ...Object.fromEntries(
            Object.entries(sent).map(([name, value]) => [name, Redacted.value(value)]),
          ),
        };
        const options = { env, timeout: 10_000 };
        const paginated = yield* Effect.promise(() =>
          run(
            "gh",
            ["api", "repos/owner/repo/issues?per_page=1", "--paginate", "--jq", ".[].number"],
            options,
          ),
        );
        assert.strictEqual(paginated.stdout, "1\n2\n");
        for (const [command, kind, number] of [
          ["issue", "issues", "1"],
          ["pr", "pull", "2"],
        ] as const) {
          const result = yield* Effect.promise(() =>
            run(
              "gh",
              [
                command,
                "view",
                `https://github.com/owner/repo/${kind}/${number}`,
                "--json",
                "title",
                "--jq",
                ".title",
              ],
              options,
            ),
          );
          assert.strictEqual(result.stdout.trim(), kind);
        }
        assert.deepStrictEqual(requests, [
          { host: "git.gw.test", path: "/api/v3/repos/owner/repo/issues?per_page=1" },
          { host: "api.github.com", path: "/repos/owner/repo/issues?per_page=1&page=2" },
          { host: "api.github.com", path: "/graphql" },
          { host: "api.github.com", path: "/graphql" },
        ]);
      } finally {
        yield* Effect.callback<void>((resume) => {
          const resolve = (value: void) => resume(Effect.succeed(value));
          server.close(() => resolve());
        });
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.remove(directory, { recursive: true, force: true }),
        );
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  30_000,
);
