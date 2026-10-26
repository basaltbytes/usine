import { assert, describe, expect, it } from "@effect/vitest";
import { type Cause, DateTime, Deferred, Duration, Effect, Fiber, Option, Queue } from "effect";
import { HttpRouter } from "effect/unstable/http";
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
import { LEASE, restore, sandboxRoutes } from "../src/sandbox/sandbox.ts";
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

  it.effect(
    "drops the stream when the command's output fails, so the client attaches from the bytes it has",
    () => {
      const sandbox = running();
      let pulls = 0;
      sandbox.state.run = () => ({
        stdin: null,
        stdout: new ReadableStream<Uint8Array>({
          pull: (controller) => {
            pulls += 1;
            if (pulls === 1) controller.enqueue(text("M  staged.ts\n"));
            else controller.error(new Error("stream reset"));
          },
        }),
        stderr: new Response("").body,
        exitCode: Promise.resolve(0),
      });
      return Effect.gen(function* () {
        const client = yield* fakeSocket;
        yield* Queue.offer(
          client.messages,
          encodeClientMessage(new ExecStart({ command: "git status --porcelain" })),
        );
        yield* execStream(NAME, client.socket);

        const [started, ...rest] = client.control();
        assert(started?._tag === "Started");
        expect(rest).toEqual([]);
        expect(client.closed).toEqual([1011]);

        const files = processFiles(started.process);
        sandbox.state.files.set(files.pid, text("4242"));
        sandbox.state.files.set(files.stdout, text("M  staged.ts\n?? new.ts\n"));
        sandbox.state.files.set(files.exit, text("0"));
        const attached = yield* fakeSocket;
        yield* attachStream(
          NAME,
          started.process,
          { stdout: text(client.output("stdout")).length, stderr: 0 },
          attached.socket,
        );

        expect(client.output("stdout") + attached.output("stdout")).toBe(
          "M  staged.ts\n?? new.ts\n",
        );
        expect(attached.control()).toEqual([
          expect.objectContaining({ _tag: "Exited", exitCode: 0 }),
        ]);
      }).pipe(Effect.provide(sandbox.layer));
    },
  );

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

  /**
   * Attaches to a command that exited with 0, and runs `during` through the sandbox routes while
   * the attach stream waits for the container to read the command's pid file.
   */
  const attachWhileReading = (
    sandbox: ReturnType<typeof running>,
    during: (
      call: (method: string, path: string, body?: string) => Effect.Effect<Response>,
    ) => Effect.Effect<void>,
  ) => {
    const process = ProcessId.make("0123456789abcdef0123456789abcdef");
    const files = processFiles(process);
    sandbox.state.files.set(files.pid, text("4242"));
    sandbox.state.files.set(files.exit, text("0"));
    const web = HttpRouter.toWebHandler(
      sandboxRoutes.pipe(HttpRouter.provideRequest(sandbox.layer)),
      { disableLogger: true },
    );
    const call = (method: string, path: string, body?: string) =>
      Effect.promise(() =>
        web.handler(
          new Request(`https://sandboxes.test/v1/sandboxes/${NAME}${path}`, {
            method,
            body: body ?? null,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    return Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const read = yield* Deferred.make<void>();
      sandbox.state.beforeRead = (path) =>
        path === files.pid
          ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(read)))
          : Effect.void;
      const client = yield* fakeSocket;
      const stream = yield* Effect.forkChild(
        attachStream(NAME, process, { stdout: 0, stderr: 0 }, client.socket),
      );
      yield* Deferred.await(reading);
      yield* during(call);
      yield* Deferred.succeed(read, undefined);
      yield* Fiber.join(stream);
      return client;
    });
  };

  it.effect(
    "keeps a credential revocation and a hold that complete while it reads the process files",
    () => {
      const sandbox = running();
      return Effect.gen(function* () {
        const client = yield* attachWhileReading(sandbox, (call) =>
          Effect.gen(function* () {
            const revoked = yield* call("PUT", "/credentials", JSON.stringify({ providers: [] }));
            const held = yield* call("POST", "/hold");
            expect([revoked.status, held.status]).toEqual([200, 200]);
          }),
        );

        expect(client.control()).toEqual([
          expect.objectContaining({ _tag: "Exited", exitCode: 0 }),
        ]);
        assert(Option.isSome(sandbox.state.stored));
        expect(sandbox.state.stored.value.held).toBe(true);
        expect(Option.isNone(sandbox.state.stored.value.credentials.github)).toBe(true);
        expect(sandbox.state.stored.value.credentials.providers).toEqual([]);
        // The Durable Object restarts and registers the stored credentials again.
        const before = sandbox.state.interceptions.length;
        yield* restore();
        expect(
          sandbox.state.interceptions.slice(before).map(({ _tag, host }) => `${_tag}:${host}`),
        ).toEqual([
          "Denied:github.com",
          "Denied:api.github.com",
          "Denied:anthropic.usine.internal",
          "Denied:openai.usine.internal",
          "Allowed:registry.npmjs.org",
        ]);
      }).pipe(Effect.provide(sandbox.layer));
    },
  );

  it.effect("refuses to attach to a sandbox destroyed while it reads the process files", () => {
    const sandbox = running();
    return Effect.gen(function* () {
      const client = yield* attachWhileReading(sandbox, (call) =>
        call("DELETE", "").pipe(Effect.map(({ status }) => expect(status).toBe(200))),
      );

      expect(client.control().map(({ _tag }) => _tag)).toEqual(["StreamFailed"]);
      expect(Option.isNone(sandbox.state.stored)).toBe(true);
    }).pipe(Effect.provide(sandbox.layer));
  });

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
