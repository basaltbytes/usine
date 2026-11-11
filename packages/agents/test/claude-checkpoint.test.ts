import { assert, it } from "@effect/vitest";
import { Effect, Logger } from "effect";
import { claudeOutputCheckpoint } from "../src/harness/claude/sdk.ts";
import { jsonLine } from "./child-host/scripted-owner.ts";

const hookRequest = jsonLine({
  type: "control_request",
  request_id: "hook",
  request: { subtype: "hook_callback" },
});
const hookResponse = jsonLine({
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
    const firstLine = yield* jsonLine(first);
    yield* checkpoint.read(Buffer.concat([hook, firstLine]));
    const blocked = yield* checkpoint.handled(first);
    assert.deepStrictEqual(blocked, { bytes: 0, covered: false });
    yield* checkpoint.inputAcknowledged(response);
    const line = yield* jsonLine(second);
    yield* checkpoint.read(line);
    const covered = yield* checkpoint.handled(second);
    assert.deepStrictEqual(covered, { bytes: line.length, covered: true });
  }),
);

it.effect("cancels only the control request with the matching request ID", () =>
  Effect.gen(function* () {
    const logs: Array<unknown> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Info") logs.push(message);
    });
    const hook = yield* hookRequest;
    const other = yield* jsonLine({
      type: "control_request",
      request_id: "other",
      request: { subtype: "hook_callback" },
    });
    const unknown = yield* jsonLine({ type: "control_cancel_request", request_id: "unknown" });
    const cancel = yield* jsonLine({ type: "control_cancel_request", request_id: "other" });
    const checkpoint = claudeOutputCheckpoint();
    const pending = yield* checkpoint.read(Buffer.concat([hook, other]));
    assert.strictEqual(pending, 0);
    const ignored = yield* checkpoint.read(unknown).pipe(Effect.provide(Logger.layer([logger])));
    assert.strictEqual(ignored, 0);
    assert.deepStrictEqual(logs, []);
    const cancelled = yield* checkpoint.read(cancel).pipe(Effect.provide(Logger.layer([logger])));
    assert.strictEqual(cancelled, 0);
    assert.deepStrictEqual(logs, [
      ["Claude cancelled a control request", { requestId: "other", released: true }],
    ]);
    const response = yield* hookResponse;
    const answered = yield* checkpoint.inputAcknowledged(response);
    assert.strictEqual(answered, hook.length + other.length + unknown.length + cancel.length);
  }),
);

for (const release of ["response", "cancellation"] as const) {
  it.effect(
    `a control ${release} does not checkpoint an application message with the same key`,
    () =>
      Effect.gen(function* () {
        const message = { type: "assistant", uuid: "hook", message: { id: "one" } };
        const line = yield* jsonLine(message);
        const checkpoint = claudeOutputCheckpoint();
        const pending = yield* checkpoint.read(line);
        assert.strictEqual(pending, 0);
        const response = yield* hookResponse;
        const cancel = yield* jsonLine({ type: "control_cancel_request", request_id: "hook" });
        const released = yield* release === "response"
          ? checkpoint.inputAcknowledged(response)
          : checkpoint.read(cancel);
        assert.strictEqual(released, 0);
        const handled = yield* checkpoint.handled(message);
        assert.deepStrictEqual(handled, {
          bytes: line.length + (release === "cancellation" ? cancel.length : 0),
          covered: true,
        });
      }),
  );
}

it.effect(
  "handling an application message does not checkpoint a control request with the same key",
  () =>
    Effect.gen(function* () {
      const hook = yield* hookRequest;
      const message = { type: "assistant", uuid: "hook", message: { id: "one" } };
      const line = yield* jsonLine(message);
      const checkpoint = claudeOutputCheckpoint();
      const pending = yield* checkpoint.read(Buffer.concat([hook, line]));
      assert.strictEqual(pending, 0);
      const handled = yield* checkpoint.handled(message);
      assert.deepStrictEqual(handled, { bytes: 0, covered: false });
      const response = yield* hookResponse;
      const answered = yield* checkpoint.inputAcknowledged(response);
      assert.strictEqual(answered, hook.length + line.length);
    }),
);

it.effect("keeps a blocked hook replayable after the main turn's result", () =>
  Effect.gen(function* () {
    const logs: Array<unknown> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Info") logs.push(message);
    });
    const hook = yield* hookRequest;
    const response = yield* hookResponse;
    const other = yield* jsonLine({
      type: "control_request",
      request_id: "answered",
      request: { subtype: "remote_tools_probe" },
    });
    const otherResponse = yield* jsonLine({
      type: "control_response",
      response: { request_id: "answered", subtype: "success" },
    });
    const assistant = { type: "assistant", uuid: "assistant", message: { id: "one" } };
    const assistantLine = yield* jsonLine(assistant);
    const result = { type: "result", subtype: "success", uuid: "result", result: "Done" };
    const line = yield* jsonLine(result);
    const checkpoint = claudeOutputCheckpoint();
    yield* checkpoint.read(Buffer.concat([hook, other, assistantLine, line]));
    const otherAnswered = yield* checkpoint.inputAcknowledged(otherResponse);
    assert.strictEqual(otherAnswered, 0);
    const handledAssistant = yield* checkpoint
      .handled(assistant)
      .pipe(Effect.provide(Logger.layer([logger])));
    assert.deepStrictEqual(handledAssistant, { bytes: 0, covered: false });
    assert.deepStrictEqual(logs, []);
    const handled = yield* checkpoint.handled(result).pipe(Effect.provide(Logger.layer([logger])));
    assert.deepStrictEqual(handled, { bytes: 0, covered: false });
    assert.deepStrictEqual(logs, [
      [
        "Claude finished a turn with unanswered control requests; the output checkpoint stays before them",
        { requests: [{ requestId: "hook", subtype: "hook_callback" }] },
      ],
    ]);
    const answered = yield* checkpoint.inputAcknowledged(response);
    assert.strictEqual(answered, hook.length + other.length + assistantLine.length + line.length);
    const nextResult = { ...result, uuid: "next-result" };
    const nextLine = yield* jsonLine(nextResult);
    const nextRead = yield* checkpoint.read(Buffer.concat([nextLine, hook]));
    assert.strictEqual(nextRead, 0);
    const nextHandled = yield* checkpoint
      .handled(nextResult)
      .pipe(Effect.provide(Logger.layer([logger])));
    assert.deepStrictEqual(nextHandled, { bytes: nextLine.length, covered: true });
    assert.lengthOf(logs, 1);
    const nextAnswered = yield* checkpoint.inputAcknowledged(response);
    assert.strictEqual(nextAnswered, hook.length);
  }),
);

it.effect("ends a stdout line at a lone carriage return, as the SDK does", () =>
  Effect.gen(function* () {
    const noise = Buffer.from("progress 50%\r\nprogress 100%\r");
    const message = { type: "assistant", uuid: "after-progress", message: { id: "one" } };
    const line = yield* jsonLine(message);
    const checkpoint = claudeOutputCheckpoint();
    const read = yield* checkpoint.read(Buffer.concat([noise, line]));
    assert.strictEqual(read, noise.length);
    const handled = yield* checkpoint.handled(message);
    assert.deepStrictEqual(handled, { bytes: line.length, covered: true });
    const beforeProgress = yield* checkpoint.read(Buffer.concat([line, noise]));
    assert.strictEqual(beforeProgress, 0);
    const handledBeforeProgress = yield* checkpoint.handled(message);
    assert.deepStrictEqual(handledBeforeProgress, {
      bytes: line.length + noise.length,
      covered: true,
    });
  }),
);
