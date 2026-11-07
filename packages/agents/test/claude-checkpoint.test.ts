import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { claudeOutputCheckpoint } from "../src/harness/claude/sdk.ts";

it.effect("checkpoints a hook only after its complete response input is acknowledged", () =>
  Effect.gen(function* () {
    const encode = (message: Schema.Json) =>
      Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(message).pipe(
        Effect.map((line) => Buffer.from(`${line}\n`)),
      );
    const hook = yield* encode({
      type: "control_request",
      request_id: "hook",
      request: { subtype: "hook_callback" },
    });
    const response = yield* encode({
      type: "control_response",
      response: { request_id: "hook", subtype: "success" },
    });
    const checkpoint = claudeOutputCheckpoint();
    const pending = yield* checkpoint.read(hook);
    assert.strictEqual(pending, 0);
    const partial = yield* checkpoint.inputAcknowledged(response.subarray(0, 15));
    assert.strictEqual(partial, 0);
    const handled = yield* checkpoint.inputAcknowledged(response.subarray(15));
    assert.strictEqual(handled, hook.length);
    const early = claudeOutputCheckpoint();
    const beforeRead = yield* early.inputAcknowledged(response);
    assert.strictEqual(beforeRead, 0);
    const afterRead = yield* early.read(hook);
    assert.strictEqual(afterRead, hook.length);
  }),
);

it.effect("covers a handled message only once all earlier output is checkpointed", () =>
  Effect.gen(function* () {
    const encode = (message: Schema.Json) =>
      Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(message).pipe(
        Effect.map((line) => Buffer.from(`${line}\n`)),
      );
    const hook = yield* encode({
      type: "control_request",
      request_id: "hook",
      request: { subtype: "hook_callback" },
    });
    const response = yield* encode({
      type: "control_response",
      response: { request_id: "hook", subtype: "success" },
    });
    const first = { type: "assistant", uuid: "first", message: { id: "one" } };
    const second = { type: "assistant", uuid: "second", message: { id: "two" } };
    const checkpoint = claudeOutputCheckpoint();
    yield* checkpoint.read(Buffer.concat([hook, yield* encode(first)]));
    assert.deepStrictEqual(checkpoint.handled(first), { bytes: 0, covered: false });
    yield* checkpoint.inputAcknowledged(response);
    const line = yield* encode(second);
    yield* checkpoint.read(line);
    assert.deepStrictEqual(checkpoint.handled(second), { bytes: line.length, covered: true });
  }),
);
