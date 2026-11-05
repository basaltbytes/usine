// SDK transports use native Promise callbacks and async iterators.
// @effect-diagnostics newPromise:off
// @effect-diagnostics asyncFunction:off
// Fixture JSON is decoded synchronously at the test boundary.
// @effect-diagnostics schemaSync:off
import { assert } from "@effect/vitest";
import { Predicate, Schema } from "effect";

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
  protocol: Schema.Literals(["claude-sdk", "codex-app-server"]),
  harnessVersion: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  scenario: Scenario,
  environment: Schema.Record(Schema.String, Schema.String),
  entries: Schema.Array(Entry),
});
export type Transcript = typeof Transcript.Type;

const isJsonArray = (value: Schema.Json): value is ReadonlyArray<Schema.Json> =>
  Array.isArray(value);
const isJsonObject = (value: Schema.Json): value is Readonly<Record<string, Schema.Json>> =>
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
  #cursor = 0;
  #ports = new Map<string, number>();
  #failure: { readonly cause: unknown } | undefined;

  readonly source: "record" | Transcript;
  constructor(source: "record" | Transcript) {
    this.source = source;
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
    const expected = this.source.entries[this.#cursor];
    try {
      assert.deepStrictEqual(
        { type: "expect_outbound", port, payload },
        expected,
        `outbound request differs at transcript entry ${this.#cursor}`,
      );
    } catch (cause) {
      this.fail(cause);
      throw cause;
    }
    this.entries.push({ type: "expect_outbound", port, payload });
    this.#cursor += 1;
    this.#pump();
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
    return inbox.take();
  }

  fail(cause: unknown): void {
    this.#failure ??= { cause };
    for (const inbox of this.#inboxes.values()) inbox.fail(this.#failure.cause);
  }

  assertComplete(): void {
    if (this.#failure !== undefined) throw this.#failure.cause;
    if (this.source !== "record") {
      this.#pump();
      assert.strictEqual(this.#cursor, this.source.entries.length, "unconsumed transcript entries");
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

  #pump(): void {
    if (this.source === "record") return;
    for (;;) {
      const entry = this.source.entries[this.#cursor];
      if (entry === undefined || entry.type === "expect_outbound") return;
      this.#cursor += 1;
      this.#inbox(entry.port).offer(entry);
    }
  }
}
