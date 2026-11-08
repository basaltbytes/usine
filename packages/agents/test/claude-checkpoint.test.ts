import { assert, it } from "@effect/vitest";
import { jsonKey } from "@usine/core/json-key";
import { Effect, Logger, Schema } from "effect";
import { claudeOutputCheckpoint } from "../src/harness/claude/sdk.ts";

const encode = (message: Schema.Json) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(message).pipe(
    Effect.map((line) => Buffer.from(`${line}\n`)),
  );
const hookRequest = encode({
  type: "control_request",
  request_id: "hook",
  request: { subtype: "hook_callback" },
});
const hookResponse = encode({
  type: "control_response",
  response: { request_id: "hook", subtype: "success" },
});

it.effect("checkpoints a hook only after its complete response input is acknowledged", () =>
  Effect.gen(function* () {
    const hook = yield* hookRequest;
    const response = yield* hookResponse;
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
    const hook = yield* hookRequest;
    const response = yield* hookResponse;
    const first = { type: "assistant", uuid: "first", message: { id: "one" } };
    const second = { type: "assistant", uuid: "second", message: { id: "two" } };
    const checkpoint = claudeOutputCheckpoint();
    const firstLine = yield* encode(first);
    yield* checkpoint.read(Buffer.concat([hook, firstLine]));
    const blocked = yield* checkpoint.handled(first);
    assert.deepStrictEqual(blocked, { bytes: 0, covered: false });
    yield* checkpoint.inputAcknowledged(response);
    const line = yield* encode(second);
    yield* checkpoint.read(line);
    const covered = yield* checkpoint.handled(second);
    assert.deepStrictEqual(covered, { bytes: line.length, covered: true });
  }),
);

it.effect("checkpoints a control request once Claude cancels it", () =>
  Effect.gen(function* () {
    const hook = yield* hookRequest;
    const cancel = yield* encode({ type: "control_cancel_request", request_id: "hook" });
    const checkpoint = claudeOutputCheckpoint();
    const pending = yield* checkpoint.read(hook);
    assert.strictEqual(pending, 0);
    const cancelled = yield* checkpoint.read(cancel);
    assert.strictEqual(cancelled, hook.length + cancel.length);
  }),
);

it.effect("keeps a blocked hook replayable after the main turn's result", () =>
  Effect.gen(function* () {
    const logs: Array<string> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Info") logs.push(jsonKey(message));
    });
    const hook = yield* hookRequest;
    const response = yield* hookResponse;
    const result = { type: "result", subtype: "success", uuid: "result", result: "Done" };
    const line = yield* encode(result);
    const checkpoint = claudeOutputCheckpoint();
    yield* checkpoint.read(Buffer.concat([hook, line]));
    const handled = yield* checkpoint.handled(result).pipe(Effect.provide(Logger.layer([logger])));
    assert.deepStrictEqual(handled, { bytes: 0, covered: false });
    assert.lengthOf(logs, 1);
    assert.include(logs[0], "hook_callback");
    const answered = yield* checkpoint.inputAcknowledged(response);
    assert.strictEqual(answered, hook.length + line.length);
  }),
);

it.effect("ends a stdout line at a lone carriage return, as the SDK does", () =>
  Effect.gen(function* () {
    const noise = Buffer.from("progress 50%\r\nprogress 100%\r");
    const message = { type: "assistant", uuid: "after-progress", message: { id: "one" } };
    const line = yield* encode(message);
    const checkpoint = claudeOutputCheckpoint();
    const read = yield* checkpoint.read(Buffer.concat([noise, line]));
    assert.strictEqual(read, noise.length);
    const handled = yield* checkpoint.handled(message);
    assert.deepStrictEqual(handled, { bytes: line.length, covered: true });
  }),
);
