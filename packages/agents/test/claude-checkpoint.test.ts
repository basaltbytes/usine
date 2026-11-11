import { assert, it } from "@effect/vitest";
import { Effect, Layer, Logger, References, Schema } from "effect";
import { claudeOutputCheckpoint } from "../src/harness/claude/sdk.ts";
import { jsonLine } from "./child-host/scripted-owner.ts";

type Checkpoint = Effect.Success<ReturnType<typeof claudeOutputCheckpoint>>;

/** Handles `message`; returns the bytes that became checkpointed and whether the checkpoint covers it. */
const handle = (checkpoint: Checkpoint, message: Schema.Json) =>
  Effect.all({ bytes: checkpoint.handled(message), covered: checkpoint.covered });

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
    const checkpoint = yield* claudeOutputCheckpoint();
    const pending = yield* checkpoint.read(hook);
    assert.strictEqual(pending, 0);
    const partial = yield* checkpoint.inputAcknowledged(response.subarray(0, 15));
    assert.strictEqual(partial, 0);
    const handled = yield* checkpoint.inputAcknowledged(response.subarray(15));
    assert.strictEqual(handled, hook.length);
    const early = yield* claudeOutputCheckpoint();
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
    const checkpoint = yield* claudeOutputCheckpoint();
    const firstLine = yield* jsonLine(first);
    yield* checkpoint.read(Buffer.concat([hook, firstLine]));
    const blocked = yield* handle(checkpoint, first);
    assert.deepStrictEqual(blocked, { bytes: 0, covered: false });
    yield* checkpoint.inputAcknowledged(response);
    const line = yield* jsonLine(second);
    yield* checkpoint.read(line);
    const covered = yield* handle(checkpoint, second);
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
    const checkpoint = yield* claudeOutputCheckpoint();
    const pending = yield* checkpoint.read(Buffer.concat([hook, other]));
    assert.strictEqual(pending, 0);
    const ignored = yield* checkpoint.read(unknown).pipe(Effect.provide(Logger.layer([logger])));
    assert.strictEqual(ignored, 0);
    assert.deepStrictEqual(logs, [
      ["Claude cancelled a control request that is not pending", { requestId: "unknown" }],
    ]);
    const cancelled = yield* checkpoint.read(cancel).pipe(Effect.provide(Logger.layer([logger])));
    assert.strictEqual(cancelled, 0);
    assert.deepStrictEqual(logs.slice(1), [
      ["Claude cancelled a control request", { requestId: "other" }],
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
        const checkpoint = yield* claudeOutputCheckpoint();
        const pending = yield* checkpoint.read(line);
        assert.strictEqual(pending, 0);
        const response = yield* hookResponse;
        const cancel = yield* jsonLine({ type: "control_cancel_request", request_id: "hook" });
        const released = yield* release === "response"
          ? checkpoint.inputAcknowledged(response)
          : checkpoint.read(cancel);
        assert.strictEqual(released, 0);
        const handled = yield* handle(checkpoint, message);
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
      const checkpoint = yield* claudeOutputCheckpoint();
      const pending = yield* checkpoint.read(Buffer.concat([hook, line]));
      assert.strictEqual(pending, 0);
      const handled = yield* handle(checkpoint, message);
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
    const checkpoint = yield* claudeOutputCheckpoint();
    yield* checkpoint.read(Buffer.concat([hook, other, assistantLine, line]));
    const otherAnswered = yield* checkpoint.inputAcknowledged(otherResponse);
    assert.strictEqual(otherAnswered, 0);
    const handledAssistant = yield* handle(checkpoint, assistant).pipe(
      Effect.provide(Logger.layer([logger])),
    );
    assert.deepStrictEqual(handledAssistant, { bytes: 0, covered: false });
    assert.deepStrictEqual(logs, []);
    const handled = yield* handle(checkpoint, result).pipe(Effect.provide(Logger.layer([logger])));
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
    const nextHandled = yield* handle(checkpoint, nextResult).pipe(
      Effect.provide(Logger.layer([logger])),
    );
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
    const checkpoint = yield* claudeOutputCheckpoint();
    const read = yield* checkpoint.read(Buffer.concat([noise, line]));
    assert.strictEqual(read, noise.length);
    const handled = yield* handle(checkpoint, message);
    assert.deepStrictEqual(handled, { bytes: line.length, covered: true });
    const beforeProgress = yield* checkpoint.read(Buffer.concat([line, noise]));
    assert.strictEqual(beforeProgress, 0);
    const handledBeforeProgress = yield* handle(checkpoint, message);
    assert.deepStrictEqual(handledBeforeProgress, {
      bytes: line.length + noise.length,
      covered: true,
    });
  }),
);

const logsAt = (level: "Debug" | "Info") => {
  const logs: Array<unknown> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === level) logs.push(message);
  });
  return {
    logs,
    layer: Layer.merge(Logger.layer([logger]), Layer.succeed(References.MinimumLogLevel)("Debug")),
  };
};

it.effect("checkpoints blank stdout lines without decoding them", () =>
  Effect.gen(function* () {
    const { logs, layer } = logsAt("Debug");
    const checkpoint = yield* claudeOutputCheckpoint();
    const blank = yield* checkpoint.read(Buffer.from("\r\n \n\r")).pipe(Effect.provide(layer));
    assert.strictEqual(blank, 5);
    assert.deepStrictEqual(logs, []);
    const noise = yield* checkpoint.read(Buffer.from("progress\r")).pipe(Effect.provide(layer));
    assert.strictEqual(noise, 9);
    assert.deepStrictEqual(logs, [["Ignoring non-JSON Claude stdout", { bytes: 9 }]]);
  }),
);

it.effect("splits stdout lines the same way whatever the read boundaries", () =>
  Effect.gen(function* () {
    const message = { type: "assistant", uuid: "split", message: { id: "one" } };
    const line = yield* jsonLine(message);
    const output = Buffer.concat([Buffer.from("50%\r\n"), line, Buffer.from("x\r")]);
    for (let size = 1; size <= output.length; size++) {
      const checkpoint = yield* claudeOutputCheckpoint();
      let read = 0;
      for (let start = 0; start < output.length; start += size)
        read += yield* checkpoint.read(output.subarray(start, start + size));
      assert.strictEqual(read, 5);
      const handled = yield* handle(checkpoint, message);
      assert.deepStrictEqual(handled, { bytes: line.length + 2, covered: true });
    }
  }),
);

it.effect("splits input lines the same way whatever the acknowledgement boundaries", () =>
  Effect.gen(function* () {
    const hook = yield* hookRequest;
    const response = yield* hookResponse;
    const message = { type: "assistant", uuid: "partial", message: { content: "x".repeat(200) } };
    const partial = (yield* jsonLine(message)).subarray(0, -1);
    assert.isAbove(partial.length, response.length);
    for (let size = 1; size <= response.length; size++) {
      const checkpoint = yield* claudeOutputCheckpoint();
      const read = yield* checkpoint.read(Buffer.concat([hook, partial]));
      assert.strictEqual(read, 0);
      let acknowledged = 0;
      for (let start = 0; start < response.length; start += size)
        acknowledged += yield* checkpoint.inputAcknowledged(response.subarray(start, start + size));
      assert.strictEqual(acknowledged, hook.length, `acknowledged in chunks of ${size} bytes`);
    }
  }),
);

for (const order of ["response-first", "request-first"] as const)
  it.effect(
    `does not let a cancelled request's late response answer a later request (${order})`,
    () => {
      const { logs, layer } = logsAt("Info");
      return Effect.gen(function* () {
        const hook = yield* hookRequest;
        const response = yield* hookResponse;
        const cancel = yield* jsonLine({ type: "control_cancel_request", request_id: "hook" });
        const checkpoint = yield* claudeOutputCheckpoint();
        const released = yield* checkpoint.read(Buffer.concat([hook, cancel]));
        assert.strictEqual(released, hook.length + cancel.length);
        if (order === "response-first") {
          const late = yield* checkpoint.inputAcknowledged(response);
          assert.strictEqual(late, 0);
          const reused = yield* checkpoint.read(hook);
          assert.strictEqual(reused, 0);
        } else {
          const reused = yield* checkpoint.read(hook);
          assert.strictEqual(reused, 0);
          const late = yield* checkpoint.inputAcknowledged(response);
          assert.strictEqual(late, 0);
        }
        assert.deepStrictEqual(logs, [
          ["Claude cancelled a control request", { requestId: "hook" }],
          [
            "Claude acknowledged the late response to a cancelled control request",
            { requestId: "hook" },
          ],
        ]);
        const answered = yield* checkpoint.inputAcknowledged(response);
        assert.strictEqual(answered, hook.length);
        assert.lengthOf(logs, 2);
      }).pipe(Effect.provide(layer));
    },
  );

it.effect(
  "lets a reused request's response answer it after an answered request's cancellation",
  () =>
    Effect.gen(function* () {
      const hook = yield* hookRequest;
      const response = yield* hookResponse;
      const cancel = yield* jsonLine({ type: "control_cancel_request", request_id: "hook" });
      const checkpoint = yield* claudeOutputCheckpoint();
      yield* checkpoint.read(hook);
      const answered = yield* checkpoint.inputAcknowledged(response);
      assert.strictEqual(answered, hook.length);
      const cancelled = yield* checkpoint.read(cancel);
      assert.strictEqual(cancelled, cancel.length);
      const reused = yield* checkpoint.read(hook);
      assert.strictEqual(reused, 0);
      const own = yield* checkpoint.inputAcknowledged(response);
      assert.strictEqual(own, hook.length);
    }),
);

it.effect(
  "does not release an answered request held behind an unanswered one when it is cancelled",
  () =>
    Effect.gen(function* () {
      const logs: Array<readonly [string, unknown]> = [];
      const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
        logs.push([logLevel, message]);
      });
      const layer = Layer.merge(
        Logger.layer([logger]),
        Layer.succeed(References.MinimumLogLevel)("Debug"),
      );
      const hook = yield* hookRequest;
      const response = yield* hookResponse;
      const behind = yield* jsonLine({
        type: "control_request",
        request_id: "behind",
        request: { subtype: "hook_callback" },
      });
      const behindResponse = yield* jsonLine({
        type: "control_response",
        response: { request_id: "behind", subtype: "success" },
      });
      const cancel = yield* jsonLine({ type: "control_cancel_request", request_id: "behind" });
      const checkpoint = yield* claudeOutputCheckpoint();
      const pending = yield* checkpoint.read(Buffer.concat([hook, behind]));
      assert.strictEqual(pending, 0);
      const answered = yield* checkpoint.inputAcknowledged(behindResponse);
      assert.strictEqual(answered, 0);
      const cancelled = yield* checkpoint.read(cancel).pipe(Effect.provide(layer));
      assert.strictEqual(cancelled, 0);
      assert.deepStrictEqual(logs, [
        [
          "Info",
          ["Claude cancelled a control request that is not pending", { requestId: "behind" }],
        ],
      ]);
      const reused = yield* checkpoint.read(behind);
      assert.strictEqual(reused, 0);
      const own = yield* checkpoint.inputAcknowledged(behindResponse);
      assert.strictEqual(own, 0);
      const released = yield* checkpoint.inputAcknowledged(response);
      assert.strictEqual(released, hook.length + behind.length + cancel.length + behind.length);
    }),
);

it.effect("logs an unanswered control request at the first turn result only", () =>
  Effect.gen(function* () {
    const { logs, layer } = logsAt("Info");
    const request = yield* jsonLine({ type: "control_request", request_id: "remote" });
    const first = { type: "result", subtype: "success", uuid: "first", result: "Done" };
    const second = { ...first, uuid: "second" };
    const checkpoint = yield* claudeOutputCheckpoint();
    const results = Buffer.concat([yield* jsonLine(first), yield* jsonLine(second)]);
    yield* checkpoint.read(Buffer.concat([request, results]));
    yield* checkpoint.handled(first).pipe(Effect.provide(layer));
    yield* checkpoint.handled(second).pipe(Effect.provide(layer));
    assert.deepStrictEqual(logs, [
      [
        "Claude finished a turn with unanswered control requests; the output checkpoint stays before them",
        { requests: [{ requestId: "remote" }] },
      ],
    ]);
  }),
);

it.effect(
  "covers handled messages once an input acknowledgement releases the hook before them",
  () =>
    Effect.gen(function* () {
      const hook = yield* hookRequest;
      const response = yield* hookResponse;
      const message = { type: "assistant", uuid: "after-hook", message: { id: "one" } };
      const line = yield* jsonLine(message);
      const checkpoint = yield* claudeOutputCheckpoint();
      yield* checkpoint.read(Buffer.concat([hook, line]));
      const blocked = yield* handle(checkpoint, message);
      assert.deepStrictEqual(blocked, { bytes: 0, covered: false });
      const answered = yield* checkpoint.inputAcknowledged(response);
      assert.strictEqual(answered, hook.length + line.length);
      const covered = yield* checkpoint.covered;
      assert.isTrue(covered);
    }),
);
