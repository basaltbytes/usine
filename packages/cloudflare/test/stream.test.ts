import { assert, describe, expect, it } from "@effect/vitest";
import { type Cause, DateTime, Duration, Effect, Fiber, Option, Queue } from "effect";
import { TestClock } from "effect/testing";
import { ProcessId } from "../src/api/api.ts";
import {
  decodeOutputFrame,
  decodeServerMessage,
  encodeClientMessage,
  ExecStart,
  StdinEnd,
} from "../src/api/stream.ts";
import { processCommand, processFiles } from "../src/sandbox/process.ts";
import { LEASE } from "../src/sandbox/sandbox.ts";
import { attachStream, execStream, type StreamSocket } from "../src/sandbox/stream.ts";
import { controlledProcess, fakeSandbox, NAME, storedSandbox, text } from "./support.ts";

const decoder = new TextDecoder();

/** A socket that records what the sandbox sends; the test feeds the client's messages. */
const fakeSocket = Effect.gen(function* () {
  const messages = yield* Queue.unbounded<string | Uint8Array, Cause.Done>();
  const sent: Array<string | Uint8Array> = [];
  const closed: Array<number> = [];
  const socket: StreamSocket = {
    messages,
    send: (message) => Effect.sync(() => void sent.push(message)),
    close: (code) => Effect.sync(() => void closed.push(code)),
  };
  const output = (channel: "stdout" | "stderr") =>
    sent
      .flatMap((message) =>
        message instanceof Uint8Array ? Option.toArray(decodeOutputFrame(message)) : [],
      )
      .filter((chunk) => chunk.channel === channel)
      .map(({ bytes }) => decoder.decode(bytes))
      .join("");
  const control = () =>
    sent.flatMap((message) =>
      message instanceof Uint8Array ? [] : Option.toArray(decodeServerMessage(message)),
    );
  return { socket, messages, sent, closed, output, control };
});

const running = () => {
  const sandbox = fakeSandbox();
  sandbox.state.running = true;
  sandbox.state.stored = Option.some(storedSandbox(DateTime.makeUnsafe(Duration.toMillis(LEASE))));
  return sandbox;
};

describe("sandbox exec stream", () => {
  it.effect(
    "runs the command with process files and relays stdin, output, and the exit code",
    () => {
      const sandbox = running();
      const command = controlledProcess();
      sandbox.state.run = () => command.process;
      return Effect.gen(function* () {
        const client = yield* fakeSocket;
        yield* Queue.offer(client.messages, encodeClientMessage(new ExecStart({ command: "cat" })));
        const stream = yield* Effect.forkChild(execStream(NAME, client.socket));
        yield* Effect.yieldNow;
        yield* Queue.offer(client.messages, text("hello"));
        yield* Queue.offer(client.messages, encodeClientMessage(new StdinEnd()));
        yield* Effect.promise(() => command.stdout("hello"));
        yield* Effect.promise(() => command.stderr("warning"));
        yield* Effect.promise(() => command.exit(0));
        yield* Fiber.join(stream);

        const [started, exited] = client.control();
        assert(started?._tag === "Started");
        expect(sandbox.state.execs).toEqual([processCommand(started.process, "cat")]);
        expect(command.received.map((bytes) => decoder.decode(bytes))).toEqual(["hello"]);
        expect(command.stdinClosed()).toBe(true);
        expect(client.output("stdout")).toBe("hello");
        expect(client.output("stderr")).toBe("warning");
        expect(exited).toEqual(expect.objectContaining({ _tag: "Exited", exitCode: 0 }));
        expect(client.closed).toEqual([1000]);
      }).pipe(Effect.provide(sandbox.layer));
    },
  );

  it.effect("closes the command's stdin when the client disconnects, and keeps it running", () => {
    const sandbox = running();
    const command = controlledProcess();
    sandbox.state.run = () => command.process;
    return Effect.gen(function* () {
      const client = yield* fakeSocket;
      yield* Queue.offer(
        client.messages,
        encodeClientMessage(new ExecStart({ command: "claude" })),
      );
      const stream = yield* Effect.forkChild(execStream(NAME, client.socket));
      yield* Effect.yieldNow;
      yield* Queue.end(client.messages);
      yield* Effect.yieldNow;

      expect(command.stdinClosed()).toBe(true);
      expect(stream.pollUnsafe()).toBeUndefined();
      yield* Effect.promise(() => command.exit(143));
      yield* Fiber.join(stream);
    }).pipe(Effect.provide(sandbox.layer));
  });

  it.effect("refuses a command for a sandbox whose container stopped", () => {
    const sandbox = running();
    sandbox.state.running = false;
    return Effect.gen(function* () {
      const client = yield* fakeSocket;
      yield* Queue.offer(
        client.messages,
        encodeClientMessage(new ExecStart({ command: "git status" })),
      );
      yield* execStream(NAME, client.socket);

      expect(client.control().map(({ _tag }) => _tag)).toEqual(["StreamFailed"]);
      expect(sandbox.state.execs).toEqual([]);
      expect(client.closed).toEqual([1011]);
    }).pipe(Effect.provide(sandbox.layer));
  });
});

describe("sandbox attach stream", () => {
  it.effect(
    "resumes a command's output after the bytes the client has, then sends its exit code",
    () => {
      const sandbox = running();
      const process = ProcessId.make("0123456789abcdef0123456789abcdef");
      const files = processFiles(process);
      sandbox.state.files.set(files.pid, text("4242"));
      sandbox.state.files.set(files.stdout, text("already seen|new output"));
      return Effect.gen(function* () {
        const client = yield* fakeSocket;
        const stream = yield* Effect.forkChild(
          attachStream(NAME, process, { stdout: "already seen|".length, stderr: 0 }, client.socket),
        );
        yield* Effect.yieldNow;
        expect(client.output("stdout")).toBe("new output");

        sandbox.state.files.set(files.stdout, text("already seen|new output and more"));
        sandbox.state.files.set(files.stderr, text("done"));
        sandbox.state.files.set(files.exit, text("0"));
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(stream);

        expect(client.output("stdout")).toBe("new output and more");
        expect(client.output("stderr")).toBe("done");
        expect(client.control()).toEqual([
          expect.objectContaining({ _tag: "Exited", exitCode: 0 }),
        ]);
      }).pipe(Effect.provide(sandbox.layer));
    },
  );

  it.effect("refuses to attach to a command the sandbox never ran", () => {
    const sandbox = running();
    return Effect.gen(function* () {
      const client = yield* fakeSocket;
      yield* attachStream(
        NAME,
        ProcessId.make("f".repeat(32)),
        { stdout: 0, stderr: 0 },
        client.socket,
      );

      expect(client.control().map(({ _tag }) => _tag)).toEqual(["StreamFailed"]);
    }).pipe(Effect.provide(sandbox.layer));
  });
});
