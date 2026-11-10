import { create, createFileRegistry, toJson, type DescMethodUnary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Predicate, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createServer } from "node:http2";
import {
  BOXD_KEY_FINGERPRINT,
  BOXD_PUBLIC_KEY,
  BOXD_ROTATED_FINGERPRINT,
  BOXD_ROTATED_KEY,
} from "./support.ts";

// Operator-only RPC: the worker's API-key client cannot manage account keys.
const operatorApi = createFileRegistry(
  create(FileDescriptorSetSchema, {
    file: [
      {
        name: "operator.proto",
        package: "boxd.api.v1",
        syntax: "proto3",
        messageType: [
          {
            name: "LinkSshKeyRequest",
            field: [
              { name: "pubkey", jsonName: "pubkey", number: 1, label: 1, type: 9 },
              { name: "device_id", jsonName: "deviceId", number: 2, label: 1, type: 9 },
              { name: "label", jsonName: "label", number: 3, label: 1, type: 9 },
            ],
          },
          { name: "LinkSshKeyResponse" },
        ],
        service: [
          {
            name: "BoxdApi",
            method: [
              {
                name: "LinkSshKey",
                inputType: ".boxd.api.v1.LinkSshKeyRequest",
                outputType: ".boxd.api.v1.LinkSshKeyResponse",
              },
            ],
          },
        ],
      },
    ],
  }),
).getService("boxd.api.v1.BoxdApi");
assert(operatorApi !== undefined);
const method = operatorApi.methods[0];
assert(method !== undefined);
const unaryMethod: DescMethodUnary = { ...method, methodKind: "unary" };

it.live(
  "operator script links and rotates the key with a session token and prints its fingerprint",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const file = `${directory}/worker.pub`;
      const token = "signed-in-session-token";
      const linked = new Map<string, string>();
      let refused = false;
      let expectedKey = BOXD_PUBLIC_KEY;
      const requests: Array<{ authorization: string | null; body: ReturnType<typeof toJson> }> = [];
      const server = createServer(
        connectNodeAdapter({
          routes: (router) =>
            router.rpc(unaryMethod, (request, context) => {
              requests.push({
                authorization: context.requestHeader.get("authorization"),
                body: toJson(unaryMethod.input, request),
              });
              if (refused)
                throw new ConnectError(
                  `requires an interactive session: ${token}`,
                  Code.PermissionDenied,
                );
              linked.set("usine:boxd-pool", expectedKey);
              return {};
            }),
        }),
      );
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          server.once("error", (cause) => resume(Effect.die(cause)));
          server.listen(0, "127.0.0.1", () => resume(Effect.void));
        }),
        () =>
          Effect.callback<void>((resume) => {
            server.close((error) => resume(error === undefined ? Effect.void : Effect.die(error)));
          }),
      );
      const address = server.address();
      assert(address !== null && !Predicate.isString(address));
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const run = (sessionToken: string | undefined) =>
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(
              process.execPath,
              [
                new URL("../../../../../infra/boxd/link-ssh-key.mjs", import.meta.url).pathname,
                file,
                "boxd-pool",
              ],
              {
                env: {
                  BOXD_TOKEN: sessionToken,
                  BOXD_BASE_URL: `http://127.0.0.1:${address.port}`,
                  BOXD_API_KEY: undefined,
                },
              },
            ),
          );
          const [stdout, stderr, code] = yield* Effect.all(
            [
              child.stdout.pipe(Stream.decodeText(), Stream.mkString),
              child.stderr.pipe(Stream.decodeText(), Stream.mkString),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          return { stdout, stderr, code: Number(code) };
        }).pipe(Effect.scoped);
      for (const [pubkey, fingerprint] of [
        [BOXD_PUBLIC_KEY, BOXD_KEY_FINGERPRINT],
        [BOXD_ROTATED_KEY, BOXD_ROTATED_FINGERPRINT],
      ] as const) {
        expectedKey = pubkey;
        yield* fs.writeFileString(file, `${pubkey}\n`);
        const result = yield* run(token);
        assert.deepStrictEqual(requests.at(-1), {
          authorization: `Bearer ${token}`,
          body: { pubkey, deviceId: "usine:boxd-pool", label: "usine worker boxd-pool" },
        });
        assert.strictEqual(result.code, 0, result.stderr);
        assert.strictEqual(result.stdout, `${fingerprint}\n`);
        assert.strictEqual(linked.get("usine:boxd-pool"), pubkey);
      }
      assert.strictEqual(linked.size, 1);
      refused = true;
      const denied = yield* run(token);
      assert.strictEqual(denied.code, 1);
      assert.strictEqual(denied.stdout, "");
      assert.include(denied.stderr, "requires an interactive session");
      assert.notInclude(denied.stderr, token);
      const missing = yield* run(undefined);
      assert.strictEqual(missing.code, 1);
      assert.include(missing.stderr, "BOXD_TOKEN");
      assert.lengthOf(requests, 3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
