import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { jsonKey } from "@usine/core/json-key";
import { CommitSha } from "@usine/core/repository";
import { MAX_STEP_OUTPUT_BYTES } from "@usine/core/step/output";
import { Cause, Crypto, Effect, Exit, PlatformError, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { collectCommand, CommandOutputLimitExceeded } from "../src/child-command.ts";
import { readOutputs } from "../src/outputs.ts";

const spec = {
  attemptId: AttemptId.make("run/step/1"),
  baseCommit: CommitSha.make("a".repeat(40)),
};

const readResponse = (response: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return yield* readOutputs(spec, () => Effect.succeed(response), crypto);
  }).pipe(Effect.provide(NodeCrypto.layer));

describe("step output collection boundary", () => {
  for (const [reason, response] of [
    [
      "at most 10 outputs",
      jsonKey({
        outputs: Array.from({ length: 11 }, (_, index) => ({
          file: `output-${index}.json`,
          envelope: { type: "example", content: null },
        })),
      }),
    ],
    [
      "8 MiB",
      jsonKey({
        outputs: [
          {
            file: "large.json",
            envelope: { type: "example", content: "é".repeat(MAX_STEP_OUTPUT_BYTES / 2) },
          },
        ],
      }),
    ],
    [
      "length of at most 128",
      jsonKey({
        outputs: [{ file: "type.json", envelope: { type: "x".repeat(129), content: null } }],
      }),
    ],
    [
      'at ["type"]',
      jsonKey({ outputs: [{ file: "empty-type.json", envelope: { type: "", content: null } }] }),
    ],
    [
      'at ["commit"]',
      jsonKey({
        outputs: [
          { file: "commit.json", envelope: { type: "example", commit: "invalid", content: null } },
        ],
      }),
    ],
    [
      'at ["unexpected"]',
      jsonKey({
        outputs: [
          { file: "extra.json", envelope: { type: "example", content: null, unexpected: true } },
        ],
      }),
    ],
    [
      "expected a .json file",
      jsonKey({ outputs: [{ file: "invalid.txt", envelope: { type: "example", content: null } }] }),
    ],
    [
      "cannot be serialized",
      `{"outputs":[{"file":"deep.json","envelope":{"type":"example","content":${"[".repeat(200_000)}0${"]".repeat(200_000)}}}]}`,
    ],
  ] as const) {
    it.effect(`rejects a forged collection with ${reason}`, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(readResponse(response));
        assert.strictEqual(failure._tag, "AgentFailure");
        assert.include(failure.message, ".usine/outputs/");
        assert.include(failure.message, reason);
      }),
    );
  }

  it.effect("accepts a 128-character opaque type", () =>
    Effect.gen(function* () {
      const type = "x".repeat(128);
      const outputs = yield* readResponse(
        jsonKey({ outputs: [{ file: "valid.json", envelope: { type, content: null } }] }),
      );
      assert.strictEqual(outputs[0]?.type, type);
    }),
  );

  it.effect("keeps hashing defects out of the retryable failure channel", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const exit = yield* Effect.exit(
        readOutputs(
          spec,
          () =>
            Effect.succeed(
              jsonKey({
                outputs: [{ file: "valid.json", envelope: { type: "example", content: null } }],
              }),
            ),
          {
            ...crypto,
            digest: () =>
              Effect.fail(
                PlatformError.badArgument({
                  module: "Crypto",
                  method: "digest",
                  description: "unsupported algorithm",
                }),
              ),
          },
        ),
      );
      assert(Exit.isFailure(exit));
      assert.isTrue(Cause.hasDies(exit.cause));
      assert.isFalse(Cause.hasFails(exit.cause));
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  for (const stream of ["stdout", "stderr"] as const) {
    it.live(`stops a command when ${stream} exceeds the byte cap before the process exits`, () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const failure = yield* Effect.flip(
          collectCommand(
            spawner,
            "launch",
            "node",
            ["-e", `process.${stream}.write('é'.repeat(513)); setInterval(() => {}, 1000);`],
            {},
            1024,
          ),
        );
        assert(Schema.is(CommandOutputLimitExceeded)(failure.cause));
        assert.strictEqual(failure.cause.maxBytes, 1024);
      }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("5 seconds")),
    );
  }

  it.live("reports oversized collection command output as an agent failure", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const failure = yield* Effect.flip(
        readOutputs(
          spec,
          (_command, _args, limit) =>
            collectCommand(
              spawner,
              "launch",
              "node",
              ["-e", "process.stdout.write('x'.repeat(2048)); setInterval(() => {}, 1000);"],
              {},
              Math.min(limit ?? Infinity, 1024),
            ).pipe(Effect.map((result) => result.stdout)),
          crypto,
        ),
      );
      assert.strictEqual(failure._tag, "AgentFailure");
      assert.include(failure.message, ".usine/outputs/");
      assert.include(failure.message, "collection exceeds");
    }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("5 seconds")),
  );
});
