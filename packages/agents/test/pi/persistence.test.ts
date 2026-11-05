// The fixture runs the public runtime in separate Node processes against a local HTTP provider.
// @effect-diagnostics newPromise:off
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFile } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
// The test endpoint needs an HTTP server, not a client.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assert, it } from "@effect/vitest";
import { HarnessSession } from "@usine/core/agent/session";
import { jsonKey } from "@usine/core/json-key";
import { SessionOperationError } from "../../src/runtime.ts";
import { Effect, Option, Schema } from "effect";

const execute = promisify(execFile);
const FixtureResult = Schema.fromJsonString(
  Schema.Struct({ saved: HarnessSession, result: Schema.String }),
);

it.live(
  "continues a saved Pi conversation by ID after its process exits",
  () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), "usine-pi-persistence-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
      );
      const bodies: Array<string> = [];
      const server = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          bodies.push(body);
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          const content =
            bodies.length === 1 ? "I saved cobalt-otter." : "The code word is cobalt-otter.";
          const frame = (
            delta: { readonly role?: string; readonly content?: string },
            finish_reason: string | null,
          ) =>
            `data: ${jsonKey({ id: "session-test", object: "chat.completion.chunk", model: "session-test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
          response.end(
            frame({ role: "assistant", content }, null) + frame({}, "stop") + "data: [DONE]\n\n",
          );
        });
      });
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error !== undefined ? reject(error) : resolve())),
            ),
        ),
      );
      const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
        server.address(),
      );
      const agentDir = join(directory, "agent");
      const checkout = join(directory, "checkout");
      mkdirSync(agentDir);
      mkdirSync(checkout);
      writeFileSync(
        join(agentDir, "models.json"),
        jsonKey({
          providers: {
            local: {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              api: "openai-completions",
              apiKey: "test-key",
              models: [
                {
                  id: "session-test",
                  name: "Session test",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32768,
                  maxTokens: 1024,
                },
              ],
            },
          },
        }),
      );
      const run = (cwd: string, id?: string) =>
        Effect.tryPromise({
          try: () =>
            execute(
              process.execPath,
              [
                "--experimental-strip-types",
                fileURLToPath(new URL("../fixtures/pi-session.mjs", import.meta.url)),
                cwd,
                ...(id === undefined ? [] : [id]),
              ],
              {
                env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
                timeout: 20_000,
              },
            ),
          catch: (cause) =>
            SessionOperationError.make({
              operation: "launch",
              sessionId: Option.none(),
              message: "Pi fixture process failed",
              cause,
            }),
        });
      const first = yield* run(checkout).pipe(
        Effect.flatMap(({ stdout }) => Schema.decodeEffect(FixtureResult)(stdout)),
      );
      assert.strictEqual(first.result, "I saved cobalt-otter.");
      assert.strictEqual(first.saved.cwd, checkout);
      const second = yield* run(checkout, first.saved.id).pipe(
        Effect.flatMap(({ stdout }) => Schema.decodeEffect(FixtureResult)(stdout)),
      );
      assert.strictEqual(second.result, "The code word is cobalt-otter.");
      assert.deepStrictEqual(second.saved, first.saved);
      assert.lengthOf(bodies, 2);
      assert.include(bodies[1] ?? "", "Remember the code word: cobalt-otter.");
      assert.include(bodies[1] ?? "", "I saved cobalt-otter.");
      assert.include(bodies[1] ?? "", "What code word did I give you?");
      const missing = yield* Effect.flip(run(checkout, "missing-session"));
      assert.include(String(missing.cause), "SessionOperationError");
      const otherCheckout = join(directory, "other-checkout");
      mkdirSync(otherCheckout);
      const isolated = yield* Effect.flip(run(otherCheckout, first.saved.id));
      assert.include(String(isolated.cause), "SessionOperationError");
      assert.lengthOf(bodies, 2, "missing sessions do not start a fresh conversation");
    }).pipe(Effect.scoped),
  90_000,
);
