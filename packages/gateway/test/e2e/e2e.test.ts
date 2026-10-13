import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { RepositoryName } from "@usine/core/repository";
import { DateTime, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { GatewayAdminApi } from "../../src/admin/api.ts";
import { AnonymousCredential, Attachment } from "../../src/attachment/attachment.ts";
import { GatewayAddresses, gatewayLayer, type Listener } from "../../src/node/node.ts";
import { ADMIN_TOKEN_VALUE, NO_PROVIDERS, WORKER, settingsLayer } from "../fixtures.ts";

// These tests reach github.com and registry.npmjs.org, anonymously, so CI needs no secret.

const PUBLIC_REPOSITORY = RepositoryName.make("octocat/Hello-World");
const LOOPBACK = { host: "127.0.0.1", port: 0 };

const gateway = gatewayLayer({ proxy: LOOPBACK, egress: LOOPBACK, admin: LOOPBACK }).pipe(
  Layer.provide(settingsLayer(NO_PROVIDERS)),
  Layer.provideMerge(FetchHttpClient.layer),
);

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const run = (command: string, args: ReadonlyArray<string>, env: Record<string, string>) =>
  Effect.callback<Ran>((resume) => {
    execFile(command, args, { env, timeout: 60_000 }, (error, stdout, stderr) =>
      resume(
        Effect.succeed({ code: error === null ? 0 : Number(error.code ?? 1), stdout, stderr }),
      ),
    );
  });

const installed = (command: string) =>
  ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", ...(process.env.PATH ?? "").split(":")].some(
    (directory) => existsSync(join(directory, command)),
  );

const scratch = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "usine-gw-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
);

/** Attaches the public repository anonymously for the test Worker and returns its caller token. */
const attachPublicRepository = Effect.gen(function* () {
  const { admin } = yield* GatewayAddresses;
  const client = yield* HttpApiClient.make(GatewayAdminApi, {
    baseUrl: `http://${admin.host}:${admin.port}`,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(ADMIN_TOKEN_VALUE)),
  });
  const attached = yield* client.attachments.attach({
    payload: new Attachment({
      worker: WORKER,
      repository: PUBLIC_REPOSITORY,
      credential: new AnonymousCredential(),
      expiresAt: DateTime.add(yield* DateTime.now, { minutes: 10 }),
    }),
  });
  return Redacted.value(attached.callerToken);
});

/** The environment a Worker child would have: nothing from this machine's git or gh configuration. */
const workerEnvironment = (home: string) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_PROMPT_DISABLED: "1",
});

/** Forwards a Unix socket to the gateway proxy, as `systemd-socket-proxyd` does on a Worker. */
const socketForwarder = (path: string, proxy: Listener) =>
  Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((client) => {
        const upstream = connect(proxy.port, proxy.host);
        client.pipe(upstream).pipe(client);
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
      });
      server.listen(path, () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  );

describe("the gateway against GitHub", () => {
  it.live(
    "git clones a public repository through git.<domain>, and only the attached one",
    () =>
      Effect.gen(function* () {
        const { proxy } = yield* GatewayAddresses;
        const caller = yield* attachPublicRepository;
        const directory = yield* scratch;
        const git = (url: string, into: string) =>
          run(
            "git",
            [
              "-c",
              `http.proxy=http://${proxy.host}:${proxy.port}`,
              "-c",
              `http.extraHeader=X-Usine-Gateway-Token: ${caller}`,
              "clone",
              "--quiet",
              url,
              join(directory, into),
            ],
            workerEnvironment(directory),
          );
        const cloned = yield* git("http://git.gw.test/octocat/Hello-World.git", "hello");
        assert.strictEqual(cloned.code, 0, cloned.stderr);
        assert.isTrue(existsSync(join(directory, "hello", "README")));
        const refused = yield* git("http://git.gw.test/octocat/Spoon-Knife.git", "spoon");
        assert.notStrictEqual(refused.code, 0);
        assert.include(refused.stderr, "403");
      }).pipe(Effect.provide(gateway)),
    90_000,
  );

  it.live.skipIf(!installed("gh"))(
    "gh api reaches the GitHub API through its http_unix_socket, as on a Worker",
    () =>
      Effect.gen(function* () {
        const { proxy } = yield* GatewayAddresses;
        const caller = yield* attachPublicRepository;
        const directory = yield* scratch;
        const socket = join(directory, "gh.sock");
        yield* socketForwarder(socket, proxy);
        yield* Effect.promise(() =>
          writeFile(join(directory, "config.yml"), `http_unix_socket: ${socket}\n`),
        );
        // `rate_limit` does not count against GitHub's anonymous rate limit, so CI runners sharing an address cannot exhaust it.
        const answered = yield* run("gh", ["api", "rate_limit", "--jq", ".resources.core.limit"], {
          ...workerEnvironment(directory),
          GH_CONFIG_DIR: directory,
          GH_HOST: "git.gw.test",
          GH_ENTERPRISE_TOKEN: caller,
        });
        assert.strictEqual(answered.code, 0, answered.stderr);
        assert.match(answered.stdout.trim(), /^\d+$/u);
      }).pipe(Effect.provide(gateway)),
    90_000,
  );

  it.live(
    "the forward proxy opens a tunnel to an allowlisted registry",
    () =>
      Effect.gen(function* () {
        const { egress } = yield* GatewayAddresses;
        const status = yield* Effect.callback<number>((resume) => {
          const outgoing = request({
            host: egress.host,
            port: egress.port,
            method: "CONNECT",
            path: "registry.npmjs.org:443",
          });
          outgoing.once("connect", (response, socket) => {
            socket.destroy();
            resume(Effect.succeed(response.statusCode ?? 0));
          });
          outgoing.once("error", (error) => resume(Effect.die(error)));
          outgoing.end();
        });
        assert.strictEqual(status, 200);
      }).pipe(Effect.provide(gateway)),
    90_000,
  );
});
