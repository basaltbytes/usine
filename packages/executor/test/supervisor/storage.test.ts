import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { SandboxRequest, SupervisorSandbox } from "@usine/agents/supervisor";
import { Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId } from "@usine/core/agent/session";
import {
  ContainerImage,
  ContainerMemoryMib,
  ContainerScratchMib,
  SupervisorLimits,
} from "@usine/core/worker";
import { Context, Effect, FileSystem, Layer, Logger, Option, Stream } from "effect";
import { containerSandboxLayer } from "../../src/supervisor/container.ts";
import { ConversationHomes } from "../../src/supervisor/homes/homes.ts";
import { conversationKey } from "../../src/supervisor/names.ts";
import { capBytes, memoryShortfall } from "../../src/supervisor/storage.ts";
import { type Input, podman, type RuntimeState, turnRuns } from "./runtime-fixture.ts";

const conversation = AgentSessionId.make("bounded");
const key = conversationKey(conversation);
const turn = SandboxRequest.make({
  conversation,
  harness: Harness.make("codex"),
  model: ModelId.make("m"),
  sources: [],
});

const sandboxAt = (root: string, limits = SupervisorLimits.make({})) =>
  containerSandboxLayer({
    root,
    image: ContainerImage.make("node:22-slim"),
    runtime: Option.some("podman"),
    limits,
    route: Option.some(
      Effect.succeed({
        credential: () => Effect.succeedNone,
        request: () => Effect.die("the test calls no model"),
      }),
    ),
  }).pipe(
    Layer.build,
    Effect.map((context) => Context.get(context, SupervisorSandbox)),
  );

/** The saved home of the test's conversation, as text. */
const savedHome = Effect.gen(function* () {
  const homes = yield* ConversationHomes;
  const saved = yield* homes.load(key);
  return yield* Option.match(saved, {
    onNone: () => Effect.succeedNone,
    onSome: (archive) => archive.pipe(Stream.decodeText(), Stream.mkString, Effect.asSome),
  });
});

/** The `tar` calls of `calls` in turns' sandboxes, or in the startup check's with `check`. */
const tars = (
  calls: ReadonlyArray<ReadonlyArray<string>>,
  flag: "-c" | "-x",
  sandbox: "turn" | "check" = "turn",
) =>
  calls.filter(
    (args) =>
      args[1] === "exec" &&
      args.includes("tar") &&
      args.includes(flag) &&
      args.some((arg) => arg.startsWith("usine-supervisor-check-")) === (sandbox === "check"),
  );

/** A temporary directory, provided with the Node.js file system. */
const withRoot = <A, E, R>(test: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-storage-" });
    return yield* test(root);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

describe("supervisor conversation storage", () => {
  it("refuses limits whose in-memory files could take more than half of the memory", () => {
    assert.deepStrictEqual(memoryShortfall(SupervisorLimits.make({})), Option.none());
    const starved = memoryShortfall(
      SupervisorLimits.make({
        memoryMib: ContainerMemoryMib.make(1024),
        conversationSizeMib: ContainerScratchMib.make(512),
      }),
    );
    assert(Option.isSome(starved));
    assert.include(starved.value, "conversation_size_mib (512) plus tmpfs_size_mib (64)");
  });

  it.effect("stops reading an archive at the first chunk past the limit", () =>
    Effect.gen(function* () {
      let pulled = 0;
      const chunk = new Uint8Array(4);
      const failure = yield* Stream.make(chunk, chunk, chunk, chunk).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            pulled += 1;
          }),
        ),
        capBytes(8, () => "too large" as const),
        Stream.runDrain,
        Effect.flip,
      );
      assert.strictEqual(failure, "too large");
      assert.strictEqual(pulled, 3);
      const exact = yield* Stream.make(chunk, chunk).pipe(
        capBytes(8, () => "too large" as const),
        Stream.runCollect,
      );
      assert.lengthOf(exact, 2);
    }),
  );

  it.live("restores the home that the previous turn saved, and saves it when a turn ends", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const calls: Array<ReadonlyArray<string>> = [];
        const inputs: Array<Input> = [];
        const runtime: RuntimeState = { starts: true };
        yield* Effect.gen(function* () {
          const sandbox = yield* sandboxAt(root);
          const first = yield* sandbox.open(turn).pipe(Effect.scoped);
          assert.isFalse(first.restored);
          assert.lengthOf(tars(calls, "-x"), 0);
          // The turn's scope closed without a save, as after a failure or a cancel.
          const afterFirst = yield* savedHome;
          assert.deepStrictEqual(afterFirst, Option.some("archive"));

          runtime.archive = { stdout: "second archive", exitCode: 0 };
          const saves = tars(calls, "-c").length;
          yield* Effect.gen(function* () {
            const second = yield* sandbox.open(turn);
            assert.isTrue(second.restored);
            yield* sandbox.save(second);
          }).pipe(Effect.scoped);
          assert.lengthOf(tars(calls, "-c"), saves + 1, "an explicit save isn't repeated");
          const afterSecond = yield* savedHome;
          assert.deepStrictEqual(afterSecond, Option.some("second archive"));
        }).pipe(Effect.provide(podman(calls, [], runtime, true, [], inputs)));
        const restored = inputs.filter(
          ({ command }) =>
            command.includes("-x") &&
            !command.some((arg) => arg.startsWith("usine-supervisor-check-")),
        );
        assert.deepStrictEqual(
          restored.map(({ text }) => text),
          ["archive"],
        );
      }),
    ),
  );

  for (const [name, archive, reason] of [
    [
      "a home larger than conversation_size_mib",
      { stdout: Stream.make(new Uint8Array(1024 ** 2), new Uint8Array(1)), exitCode: 0 },
      "The conversation's home is larger than supervisor_limits.conversation_size_mib (1 MiB), so usine kept the state that the previous turn saved",
    ],
    [
      "a failed archive",
      {
        stdout: "torn",
        stderr:
          "tar: home/.codex/sessions: Cannot open: Permission denied\ntar: Exiting with failure status due to previous errors\n",
        exitCode: 2,
      },
      "Can't save the conversation's home: tar: home/.codex/sessions: Cannot open: Permission denied",
    ],
  ] as const)
    it.live(`keeps the previous saved home after ${name}, and names the cause`, () =>
      withRoot((root) =>
        Effect.gen(function* () {
          const runtime: RuntimeState = { starts: true };
          yield* Effect.gen(function* () {
            const sandbox = yield* sandboxAt(
              root,
              SupervisorLimits.make({ conversationSizeMib: ContainerScratchMib.make(1) }),
            );
            yield* sandbox.open(turn).pipe(Effect.scoped);
            runtime.archive = archive;
            const failure = yield* Effect.gen(function* () {
              const seat = yield* sandbox.open(turn);
              return yield* sandbox.save(seat).pipe(Effect.flip);
            }).pipe(Effect.scoped);
            assert.strictEqual(failure.message, reason);
            const kept = yield* savedHome;
            assert.deepStrictEqual(kept, Option.some("archive"));
          }).pipe(Effect.provide(podman([], [], runtime)));
        }),
      ),
    );

  it.live("refuses a turn whose saved home can't be restored, with tar's reason first", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const calls: Array<ReadonlyArray<string>> = [];
        const runtime: RuntimeState = { starts: true };
        yield* Effect.gen(function* () {
          const sandbox = yield* sandboxAt(root);
          yield* sandbox.open(turn).pipe(Effect.scoped);
          runtime.restore = {
            stdout: "",
            stderr: "tar: home/.codex/history.jsonl: Cannot write: No space left on device\n",
            exitCode: 2,
          };
          const failure = yield* sandbox.open(turn).pipe(Effect.scoped, Effect.flip);
          assert.strictEqual(
            failure.message,
            "Can't restore the conversation's saved home: tar: home/.codex/history.jsonl: Cannot write: No space left on device",
          );
        }).pipe(Effect.provide(podman(calls, [], runtime)));
        const started = turnRuns(calls).map((args) => args[args.indexOf("--name") + 1]);
        assert.isTrue(
          started.every((name) =>
            calls.some(([, command, , removed]) => command === "rm" && removed === name),
          ),
          "each turn's container is removed",
        );
      }),
    ),
  );

  it.live("refuses to mount a workspace through a link, before starting a container", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const calls: Array<ReadonlyArray<string>> = [];
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "usine-outside-" });
        yield* fs.makeDirectory(`${root}/conversations/${key}`, { recursive: true });
        yield* fs.symlink(outside, `${root}/conversations/${key}/workspace`);
        const refused = yield* Effect.gen(function* () {
          const sandbox = yield* sandboxAt(root);
          return yield* sandbox.open(turn).pipe(Effect.scoped, Effect.flip);
        }).pipe(Effect.provide(podman(calls)));
        assert.include(refused.message, "is a SymbolicLink, not a directory");
        assert.lengthOf(turnRuns(calls), 0);
      }),
    ),
  );

  it.live("bounds the session files that the orchestrator's own harness writes", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const calls: Array<ReadonlyArray<string>> = [];
        const sessions = `${root}/conversations/${key}/workspace/.usine/pi/sessions`;
        const limits = SupervisorLimits.make({ conversationSizeMib: ContainerScratchMib.make(1) });
        yield* Effect.gen(function* () {
          const sandbox = yield* sandboxAt(root, limits);
          const saved = yield* Effect.gen(function* () {
            const seat = yield* sandbox.open(turn);
            // The turn's harness process writes past the limit on the orchestrator.
            yield* fs.makeDirectory(sessions, { recursive: true });
            yield* fs.writeFile(`${sessions}/session.jsonl`, new Uint8Array(1024 ** 2 + 1));
            return yield* sandbox.save(seat).pipe(Effect.flip);
          }).pipe(Effect.scoped);
          assert.include(saved.message, "The conversation's saved sessions use 2 MiB");
          const runs = turnRuns(calls).length;
          const refused = yield* sandbox.open(turn).pipe(Effect.scoped, Effect.flip);
          assert.strictEqual(refused.message, saved.message);
          assert.lengthOf(turnRuns(calls), runs, "a refused turn starts no container");
          yield* fs.writeFile(`${sessions}/session.jsonl`, new Uint8Array(1024));
          const resumed = yield* sandbox.open(turn).pipe(Effect.scoped);
          assert.isTrue(resumed.restored);
        }).pipe(Effect.provide(podman(calls)));
      }),
    ),
  );

  it.live(
    "removes every conversation image and directory of the FUSE storage at startup, with a log line each",
    () =>
      withRoot((root) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outside = yield* fs.makeTempDirectoryScoped({ prefix: "usine-outside-" });
          yield* fs.writeFileString(`${outside}/keep`, "outside the instance");
          const legacy = conversationKey(AgentSessionId.make("legacy"));
          const creating = conversationKey(AgentSessionId.make("creating"));
          // A conversation whose image was never created, with a link that a turn's shell left.
          const imageless = conversationKey(AgentSessionId.make("imageless"));
          yield* fs.makeDirectory(`${root}/disks`, { recursive: true });
          yield* fs.writeFileString(`${root}/disks/${legacy}.ext4`, "image");
          yield* fs.writeFileString(`${root}/disks/${creating}.ext4.creating`, "image");
          for (const directory of [legacy, creating, imageless])
            yield* fs.makeDirectory(`${root}/conversations/${directory}/home`, { recursive: true });
          yield* fs.symlink(outside, `${root}/conversations/${imageless}/home/link`);
          const removals: Array<unknown> = [];
          yield* sandboxAt(root).pipe(
            Effect.provide([
              podman([]),
              Logger.layer([
                Logger.make<unknown, void>(({ message }) => {
                  if (Array.isArray(message) && String(message[0]).startsWith("Removed supervisor"))
                    removals.push(message[1]);
                }),
              ]),
            ]),
          );
          assert.sameDeepMembers(removals, [
            { path: `${root}/disks/${legacy}.ext4` },
            { path: `${root}/disks/${creating}.ext4.creating` },
            ...[legacy, creating, imageless].map((key) => ({
              path: `${root}/conversations/${key}`,
            })),
          ]);
          const disks = yield* fs.exists(`${root}/disks`);
          assert.isFalse(disks);
          const conversations = yield* fs.readDirectory(`${root}/conversations`);
          assert.deepStrictEqual(conversations, []);
          const kept = yield* fs.readFileString(`${outside}/keep`);
          assert.strictEqual(kept, "outside the instance", "removal doesn't follow links");
        }),
      ),
  );
});

describe("the supervisor's startup check", () => {
  it.live("reports ready only after a container ran with a turn's limits and in-memory home", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const calls: Array<ReadonlyArray<string>> = [];
        yield* Effect.gen(function* () {
          const sandbox = yield* sandboxAt(root);
          const checked = yield* sandbox.checked;
          assert.deepStrictEqual(checked, Option.none());
        }).pipe(Effect.provide(podman(calls)));
        const check = calls.find(
          (args) =>
            args[1] === "run" && args.includes("usine.supervisor.conversation=usine-startup-check"),
        );
        assert(check !== undefined);
        assert.isTrue(check.some((arg) => arg.startsWith("type=tmpfs,")));
        assert.include(check, "--memory");
        assert.lengthOf(tars(calls, "-c", "check"), 1);
        assert.lengthOf(tars(calls, "-x", "check"), 1);
      }),
    ),
  );

  it.live("refuses turns with the reason when the check fails", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root);
        const checked = yield* sandbox.checked;
        assert.deepStrictEqual(
          Option.map(checked, ({ message }) => message),
          Option.some(
            "The supervisor's startup check failed: Can't save the conversation's home: sh: 1: tar: not found",
          ),
        );
        assert(Option.isSome(checked));
        const refused = yield* sandbox.open(turn).pipe(Effect.scoped, Effect.flip);
        assert.strictEqual(refused.message, checked.value.message);
      }).pipe(
        Effect.provide(
          podman([], [], {
            starts: true,
            archive: { stdout: "", stderr: "sh: 1: tar: not found\n", exitCode: 127 },
          }),
        ),
      ),
    ),
  );

  it.effect("doesn't hold the layer while the runtime check runs", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root).pipe(
          Effect.provide(podman([], [], { starts: true, image: "hang" })),
        );
        const unavailable = yield* sandbox.unavailable;
        assert(Option.isSome(unavailable));
        assert.include(unavailable.value.message, "The supervisor isn't ready yet");
      }),
    ),
  );
});
