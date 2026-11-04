import { jsonKey } from "@usine/core/json-key";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { MAX_STEP_OUTPUT_BYTES, StepOutputName, StepOutputType } from "@usine/core/step/output";
import { type StubParent, stubAttemptRuntime, StubStorage } from "@usine/durable/testing";
import { StepOutputStore } from "@usine/engine/step-outputs";
import { Effect, FileSystem, Option } from "effect";
import { output, run, submission, TOKEN, waitFor, withLocalEngine } from "./support.ts";

const content = { title: "Walkthrough é", text: "first line\nsecond line" };

describe("local step outputs", () => {
  it.live("succeeds without outputs after git clean removes the output directory", () => {
    const parent: StubParent = ({ request }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const prepared = yield* fs.exists(`${request.cwd}/.usine/outputs`);
        assert.isTrue(prepared);
        yield* run("git", ["clean", "-fdx"], request.cwd);
        const remaining = yield* fs.exists(`${request.cwd}/.usine/outputs`);
        assert.isFalse(remaining);
        return "Completed after checkout cleanup";
      }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
    return withLocalEngine(
      { attemptRuntime: stubAttemptRuntime(new StubStorage(), parent) },
      ({ engine }) =>
        Effect.gen(function* () {
          const accepted = yield* engine.submit(submission(5));
          assert(accepted._tag === "Claimed");
          const finished = yield* waitFor(engine, accepted.runId, "Succeeded");
          assert.lengthOf(finished.attempts, 1);
          assert(Option.isSome(finished.step.result));
          assert.deepStrictEqual(finished.step.result.value.outputs, []);
        }),
    );
  });

  it.live("fails once with an agent error when the output directory is replaced by a file", () => {
    const parent: StubParent = ({ request }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(`${request.cwd}/.usine/outputs`, { recursive: true });
        yield* fs.writeFileString(`${request.cwd}/.usine/outputs`, "not a directory");
        return "Completed with an unreadable output directory";
      }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
    return withLocalEngine(
      { attemptRuntime: stubAttemptRuntime(new StubStorage(), parent) },
      ({ engine }) =>
        Effect.gen(function* () {
          const accepted = yield* engine.submit(submission(6));
          assert(accepted._tag === "Claimed");
          const finished = yield* waitFor(engine, accepted.runId, "Failed");
          assert.lengthOf(finished.attempts, 1);
          for (const attempt of finished.attempts) {
            assert(Option.isSome(attempt.outcome) && attempt.outcome.value._tag === "Failed");
            const failure = attempt.outcome.value.failure;
            assert(failure._tag === "AgentFailure");
            assert.strictEqual(failure.message, ".usine/outputs/: expected a directory");
          }
        }),
    );
  });

  it.live("stores a document with its ref and excludes it from the attempt's commit", () => {
    let committed = "";
    const parent: StubParent = ({ request }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${request.cwd}/.usine/outputs/walkthrough.json`,
          jsonKey({ type: "balade.walkthrough", commit: request.spec.baseCommit, content }),
        );
        yield* fs.writeFileString(`${request.cwd}/result.txt`, "work\n");
        yield* run("git", ["add", "-A"], request.cwd);
        yield* run(
          "git",
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "Write result",
          ],
          request.cwd,
        );
        committed = yield* output("git", ["show", "--pretty=", "--name-only", "HEAD"], request.cwd);
        return "Completed with an output";
      }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
    return withLocalEngine(
      { attemptRuntime: stubAttemptRuntime(new StubStorage(), parent) },
      ({ engine }) =>
        Effect.gen(function* () {
          const base = submission(1);
          const accepted = yield* engine.submit({
            ...base,
            itemKey: ItemKey.make(jsonKey(["github", "acme/demo", 1])),
          });
          assert(accepted._tag === "Claimed");
          const finished = yield* waitFor(engine, accepted.runId, "Succeeded");
          assert(Option.isSome(finished.step.result));
          const result = finished.step.result.value;
          assert.lengthOf(result.outputs, 1);
          assert.strictEqual(result.outputs[0]?.type, "balade.walkthrough");
          assert.notProperty(result.outputs[0], "content");
          assert.strictEqual(
            result.outputs[0]?.size,
            new TextEncoder().encode(jsonKey(content)).byteLength,
          );
          assert.match(result.outputs[0]?.sha256 ?? "", /^[a-f0-9]{64}$/u);
          assert.strictEqual(committed.trim(), "result.txt");
          const store = yield* StepOutputStore;
          const refs = yield* store.list(
            base.repository,
            ItemNumber.make(1),
            Option.some(StepOutputType.make("balade.walkthrough")),
          );
          assert.lengthOf(refs, 1);
          const ref = refs[0];
          assert(ref !== undefined);
          const document = yield* store.read(ref.attemptId, StepOutputName.make("walkthrough"));
          assert(Option.isSome(document));
          assert.deepStrictEqual(document.value.content, content);
        }),
    );
  });

  it.live("stores size and SHA-256 for the content after credential scrubbing", () => {
    const parent: StubParent = ({ request }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${request.cwd}/.usine/outputs/diagnostic.json`,
          jsonKey({
            type: "example.diagnostic",
            content: { message: `é\nAuthorization: Bearer ${TOKEN}`, nested: [TOKEN] },
          }),
        );
        return "Completed with a diagnostic output";
      }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
    return withLocalEngine(
      { attemptRuntime: stubAttemptRuntime(new StubStorage(), parent) },
      ({ engine }) =>
        Effect.gen(function* () {
          const accepted = yield* engine.submit(submission(7));
          assert(accepted._tag === "Claimed");
          const finished = yield* waitFor(engine, accepted.runId, "Succeeded");
          assert(Option.isSome(finished.step.result));
          const ref = finished.step.result.value.outputs[0];
          const attempt = finished.attempts[0];
          assert(ref !== undefined && attempt !== undefined);
          const store = yield* StepOutputStore;
          const document = yield* store.read(attempt.id, ref.name);
          assert(Option.isSome(document));
          assert.deepStrictEqual(document.value.content, {
            message: "é\nAuthorization: Bearer [REDACTED]",
            nested: ["[REDACTED]"],
          });
          const body = jsonKey(document.value.content);
          assert.strictEqual(ref.size, new TextEncoder().encode(body).byteLength);
          assert.strictEqual(
            ref.sha256,
            "8e801b9c8bf6c44132bb0249af25d12f440294599b3821eb220014a3e02dbcc9",
          );
          assert.strictEqual(document.value.size, ref.size);
          assert.strictEqual(document.value.sha256, ref.sha256);
        }),
    );
  });

  it.live("rejects a bounded file whose normalized JSON content exceeds 8 MiB", () => {
    const body = `{"type":"numeric.example","content":[${"1e20,".repeat(400_000)}1e20]}`;
    assert.isBelow(new TextEncoder().encode(body).byteLength, MAX_STEP_OUTPUT_BYTES);
    const parent: StubParent = ({ request }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${request.cwd}/.usine/outputs/numbers.json`, body);
        return "Completed with numeric content";
      }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
    return withLocalEngine(
      { attemptRuntime: stubAttemptRuntime(new StubStorage(), parent) },
      ({ engine }) =>
        Effect.gen(function* () {
          const accepted = yield* engine.submit(submission(4));
          assert(accepted._tag === "Claimed");
          const finished = yield* waitFor(engine, accepted.runId, "Failed");
          assert.lengthOf(finished.attempts, 1);
          const attempt = finished.attempts[0];
          assert(attempt !== undefined && Option.isSome(attempt.outcome));
          assert(attempt.outcome.value._tag === "Failed");
          const failure = attempt.outcome.value.failure;
          assert(failure._tag === "AgentFailure");
          assert.include(failure.message, ".usine/outputs/numbers.json");
          assert.include(failure.message, "8 MiB");
        }),
    );
  });

  for (const [reason, body] of [
    ["invalid JSON", "{"],
    ["commit must equal", jsonKey({ type: "balade.walkthrough", commit: "f".repeat(40), content })],
    ["8 MiB", " ".repeat(MAX_STEP_OUTPUT_BYTES + 1)],
    ["type", jsonKey({ type: "", content })],
    ["128 characters", jsonKey({ type: "x".repeat(129), content })],
    [
      "cannot be serialized",
      `{"type":"nested","content":${"[".repeat(200_000)}0${"]".repeat(200_000)}}`,
    ],
  ] as const) {
    it.live(`fails the attempt and salvages its work when walkthrough.json has ${reason}`, () => {
      const parent: StubParent = ({ request }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(`${request.cwd}/.usine/outputs/walkthrough.json`, body);
          yield* fs.writeFileString(`${request.cwd}/unfinished.txt`, "save this work\n");
          return "Attempt completed";
        }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
      return withLocalEngine(
        { attemptRuntime: stubAttemptRuntime(new StubStorage(), parent) },
        ({ engine }) =>
          Effect.gen(function* () {
            const accepted = yield* engine.submit(submission(2));
            assert(accepted._tag === "Claimed");
            const finished = yield* waitFor(engine, accepted.runId, "Failed");
            assert.lengthOf(finished.attempts, 1);
            const attempt = finished.attempts[0];
            assert(attempt !== undefined && Option.isSome(attempt.outcome));
            assert(attempt.outcome.value._tag === "Failed");
            const failure = attempt.outcome.value.failure;
            assert(failure._tag === "AgentFailure");
            assert.include(failure.message, ".usine/outputs/walkthrough.json");
            assert.include(failure.message, reason);
            assert(Option.isSome(attempt.salvage) && attempt.salvage.value._tag === "Pushed");
          }),
      );
    });
  }
  it.live("rejects more than ten output documents with a file-specific failure", () => {
    const parent: StubParent = ({ request }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (let index = 0; index < 11; index += 1) {
          yield* fs.writeFileString(
            `${request.cwd}/.usine/outputs/output-${String(index).padStart(2, "0")}.json`,
            '{"type":"example","content":null}',
          );
        }
        return "Completed";
      }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
    return withLocalEngine(
      { attemptRuntime: stubAttemptRuntime(new StubStorage(), parent) },
      ({ engine }) =>
        Effect.gen(function* () {
          const accepted = yield* engine.submit(submission(3));
          assert(accepted._tag === "Claimed");
          const finished = yield* waitFor(engine, accepted.runId, "Failed");
          const attempt = finished.attempts[0];
          assert(attempt !== undefined && Option.isSome(attempt.outcome));
          assert(attempt.outcome.value._tag === "Failed");
          const failure = attempt.outcome.value.failure;
          assert(failure._tag === "AgentFailure");
          assert.include(failure.message, ".usine/outputs/output-10.json");
          assert.include(failure.message, "at most 10");
        }),
    );
  });
});
