// SDK transports use native Promise callbacks and async iterators.
// @effect-diagnostics newPromise:off
// @effect-diagnostics asyncFunction:off
// Fixture JSON is decoded synchronously at the test boundary.
// @effect-diagnostics schemaSync:off
import { assert } from "@effect/vitest";
import { Deferred, Effect, Exit, Option, Predicate, Schema } from "effect";

export const Scenario = Schema.Literals([
  "simple",
  "steer",
  "queued-message",
  "interrupt-guidance",
  "hold-release",
  "transport-loss",
  "restart",
  "credential-changed",
  "early-exit",
  "host-tool",
  "closed-tools",
]);
export type Scenario = typeof Scenario.Type;

const Outbound = Schema.Struct({
  type: Schema.Literal("expect_outbound"),
  port: Schema.String,
  payload: Schema.Json,
});
const Inbound = Schema.Struct({
  type: Schema.Literal("emit_inbound"),
  port: Schema.String,
  payload: Schema.Json,
});
const RuntimeExit = Schema.Struct({
  type: Schema.Literal("runtime_exit"),
  port: Schema.String,
  code: Schema.NullOr(Schema.Int),
  error: Schema.NullOr(Schema.String),
});
const Entry = Schema.Union([Outbound, Inbound, RuntimeExit]);
type Entry = typeof Entry.Type;
type Incoming = Exclude<Entry, typeof Outbound.Type>;

export const Transcript = Schema.Struct({
  protocol: Schema.Literals(["claude-sdk", "codex-app-server", "pi-provider-stream"]),
  harnessVersion: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  scenario: Scenario,
  environment: Schema.Record(Schema.String, Schema.String),
  entries: Schema.Array(Entry),
});
export type Transcript = typeof Transcript.Type;

const isJsonArray = (value: Schema.Json): value is ReadonlyArray<Schema.Json> =>
  Array.isArray(value);
export const isJsonObject = (value: Schema.Json): value is Readonly<Record<string, Schema.Json>> =>
  Predicate.isObject(value);

const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

class Inbox {
  readonly pending: Array<Incoming> = [];
  readonly waiters: Array<{
    readonly resolve: (value: Incoming) => void;
    readonly reject: (cause: unknown) => void;
  }> = [];
  offer(value: Incoming): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.pending.push(value);
    else waiter.resolve(value);
  }
  fail(cause: unknown): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(cause);
  }
  take(): Promise<Incoming> {
    const value = this.pending.shift();
    return value === undefined
      ? new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
      : Promise.resolve(value);
  }
}

export class Tape {
  readonly entries: Array<Entry> = [];
  readonly #inboxes = new Map<string, Inbox>();
  readonly #bindings = new Map<string, string>();
  #progress = Deferred.makeUnsafe<void>();
  readonly #groups = new Map<
    string,
    { entries: Array<{ entry: Entry; index: number }>; cursor: number }
  >();
  readonly failure = Deferred.makeUnsafe<never>();
  #ports = new Map<string, number>();
  #failure: { readonly cause: unknown } | undefined;

  readonly source: "record" | Transcript;
  constructor(source: "record" | Transcript) {
    this.source = source;
    if (source !== "record")
      source.entries.forEach((entry, index) => {
        const name = this.#group(entry.port);
        const group = this.#groups.get(name) ?? { entries: [], cursor: 0 };
        group.entries.push({ entry, index });
        this.#groups.set(name, group);
      });
  }

  port(protocol: string): string {
    const next = (this.#ports.get(protocol) ?? 0) + 1;
    this.#ports.set(protocol, next);
    return `${protocol}:${next}`;
  }

  bind(value: string, placeholder: string): void {
    assert(value.length > 0);
    this.#bindings.set(value, placeholder);
  }

  normalize(value: Schema.Json): Schema.Json {
    const bindings = [...this.#bindings].sort(([left], [right]) => right.length - left.length);
    const redact = (input: Schema.Json): Schema.Json => {
      if (Predicate.isString(input)) {
        let text = input;
        for (const [actual, placeholder] of bindings) text = text.replaceAll(actual, placeholder);
        return text;
      }
      if (isJsonArray(input)) return input.map(redact);
      if (isJsonObject(input))
        return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, redact(item)]));
      return input;
    };
    return redact(json(encode(value)));
  }

  outbound(port: string, value: Schema.Json): void {
    const payload = this.normalize(value);
    if (this.source === "record") {
      this.entries.push({ type: "expect_outbound", port, payload });
      return;
    }
    this.#pump();
    const group = this.#groups.get(this.#group(port));
    const expected = group?.entries[group.cursor];
    try {
      assert.deepStrictEqual(
        { type: "expect_outbound", port, payload },
        expected?.entry,
        `outbound request differs at transcript entry ${expected?.index ?? "end"} on ${port}\n` +
          `- expected: ${expected === undefined ? "<end>" : encode(expected.entry)}\n` +
          `+ received: ${encode({ type: "expect_outbound", port, payload })}`,
      );
    } catch (cause) {
      this.fail(cause);
      throw cause;
    }
    this.entries.push({ type: "expect_outbound", port, payload });
    if (group !== undefined) group.cursor += 1;
    this.#pump();
    this.#advance();
  }

  inbound(port: string, value: Schema.Json): void {
    assert.strictEqual(this.source, "record");
    this.entries.push({ type: "emit_inbound", port, payload: this.normalize(value) });
  }

  exit(port: string, code: number | null, error: string | null): void {
    assert.strictEqual(this.source, "record");
    const normalized = this.normalize(error);
    assert(normalized === null || Predicate.isString(normalized));
    this.entries.push({ type: "runtime_exit", port, code, error: normalized });
  }

  read(port: string): Promise<Incoming> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure.cause);
    const inbox = this.#inbox(port);
    this.#pump();
    return inbox.take().then((entry) => {
      this.#advance();
      return entry;
    });
  }

  fail(cause: unknown): void {
    this.#failure ??= { cause };
    Deferred.doneUnsafe(this.failure, Exit.die(this.#failure.cause));
    for (const inbox of this.#inboxes.values()) inbox.fail(this.#failure.cause);
  }

  /**
   * Waits until a replay has consumed and read every transcript entry, so a request that a stopped
   * session sends late still meets its entry. It stops waiting after 5 seconds without transport progress
   * or once the replay fails, and leaves the verdict to `assertComplete`.
   */
  readonly settled: Effect.Effect<void> = Effect.gen({ self: this }, function* () {
    if (this.source === "record") return;
    for (;;) {
      this.#pump();
      const consumed =
        [...this.#groups.values()].every((group) => group.cursor === group.entries.length) &&
        [...this.#inboxes.values()].every((inbox) => inbox.pending.length === 0);
      if (consumed || this.#failure !== undefined) return;
      const progress = yield* Deferred.await(this.#progress).pipe(
        Effect.timeoutOption("5 seconds"),
      );
      if (Option.isNone(progress)) return;
    }
  });

  assertComplete(): void {
    if (this.#failure !== undefined) throw this.#failure.cause;
    if (this.source !== "record") {
      this.#pump();
      for (const [name, group] of this.#groups)
        assert.strictEqual(
          group.cursor,
          group.entries.length,
          `unconsumed transcript entries in ${name}`,
        );
      for (const [port, inbox] of this.#inboxes)
        assert.lengthOf(inbox.pending, 0, `unread transport output on ${port}`);
    }
  }

  #inbox(port: string): Inbox {
    const existing = this.#inboxes.get(port);
    if (existing !== undefined) return existing;
    const inbox = new Inbox();
    this.#inboxes.set(port, inbox);
    return inbox;
  }

  /**
   * Fails `effect` when a replay sees no transport progress for 5 seconds. The window also
   * counts work inside `effect` that never touches the transport, such as building layers.
   */
  readonly guard = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const idle = Effect.gen({ self: this }, function* () {
      for (;;) {
        const progress = yield* Deferred.await(this.#progress).pipe(
          Effect.timeoutOption("5 seconds"),
        );
        if (Option.isSome(progress)) continue;
        this.fail(new Error(`replay idle for 5 seconds; ${this.#pending()}`));
      }
    });
    return Effect.raceFirst(
      effect,
      this.source === "record"
        ? Deferred.await(this.failure)
        : Effect.raceFirst(Deferred.await(this.failure), idle),
    );
  };

  #pending(): string {
    const missing = [...this.#groups.values()].flatMap((group) => {
      const next = group.entries[group.cursor];
      return next === undefined
        ? []
        : [`transcript entry ${next.index} on ${next.entry.port}: ${encode(next.entry)}`];
    });
    const unread = [...this.#inboxes].flatMap(([port, inbox]) =>
      inbox.pending.map((entry) => `${port}: ${encode(entry)}`),
    );
    const sections = [
      ...(missing.length === 0 ? [] : [`missing requests:\n${missing.join("\n")}`]),
      ...(unread.length === 0 ? [] : [`inbound frames never read:\n${unread.join("\n")}`]),
    ];
    return sections.length === 0 ? "no transcript entries pending" : sections.join("\n");
  }

  #advance(): void {
    Deferred.doneUnsafe(this.#progress, Effect.void);
    this.#progress = Deferred.makeUnsafe<void>();
  }

  #group(port: string): string {
    return port.split("/")[0] ?? port;
  }

  #pump(): void {
    for (const group of this.#groups.values()) {
      for (;;) {
        const next = group.entries[group.cursor];
        if (next === undefined || next.entry.type === "expect_outbound") break;
        group.cursor += 1;
        this.#inbox(next.entry.port).offer(next.entry);
      }
    }
  }
}
