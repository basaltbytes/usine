import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, RoleName, RoleSession } from "@usine/core/agent/session";
import { WorkerName } from "@usine/core/worker";
import { type Brand, Context, DateTime, Effect, Exit, Layer, Option, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { LocalProcess } from "../src/child-host/child-host.ts";
import { AdmissionContext, AdmittedBrain } from "../src/harness/admission.ts";
import { catalog } from "../src/harness/catalog.ts";
import { checkedPreflight } from "../src/harness/runtime.ts";
import { continuationPolicy } from "../src/harness/continuation.ts";
import { SessionSpec, StartPrompt } from "../src/harness/contract.ts";
import { Harnesses, type HarnessRuntime } from "../src/harness/node.ts";
import { RolePlacements, RoleSpec } from "../src/harness/role.ts";
import { openWithTools } from "../src/harness/runtime.ts";
import {
  callHostTool,
  decodeHostToolInput,
  hostToolNames,
  hostToolSet,
} from "../src/harness/tools.ts";
import { AgentResultError, RestartState, WorkingDirectory } from "../src/runtime.ts";
import { collectLogs } from "./logs.ts";

class NoteMissing extends Schema.TaggedError<
  NoteMissing,
  Brand.Brand<"@usine/agents/test/tools/NoteMissing">
>("@usine/agents/test/tools/NoteMissing")("NoteMissing", {
  note: Schema.String,
}) {}

/** The member whose token a role's tools act with. */
class Member extends Context.Service<Member, { readonly login: string }>()(
  "@usine/agents/test/harness-tools.test/Member",
) {}

const ReadNote = Tool.make("read_note", {
  description: "Reads a note.",
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.Struct({ text: Schema.String, by: Schema.String }),
  failure: NoteMissing,
  dependencies: [Member],
});
const Explode = Tool.make("explode", { description: "Dies." });
const tools = Toolkit.make(ReadNote, Explode);
const handlers = tools.toLayer({
  read_note: ({ name }) =>
    name === "greeting"
      ? Effect.gen(function* () {
          const { login } = yield* Member;
          return { text: "hello", by: login };
        })
      : Effect.fail(NoteMissing.make({ note: name })),
  explode: () => Effect.die(new Error("boom")),
});

describe("usine tool sets", () => {
  it.effect("bind handlers to the services of the context that opens the session", () =>
    Effect.gen(function* () {
      const bound = yield* hostToolSet(tools).pipe(
        Effect.provide(Layer.merge(handlers, Layer.succeed(Member)({ login: "ada" }))),
      );
      assert.deepStrictEqual(
        bound.tools.map(({ name, description }) => ({ name, description })),
        [
          { name: "read_note", description: "Reads a note." },
          { name: "explode", description: "Dies." },
        ],
      );
      assert.strictEqual(bound.tools[0]?.parameters.type, "object");
      const [read, explode] = bound.tools;
      assert(read !== undefined && explode !== undefined);
      // The handler reads the member that the opening context provided, not one of its own.
      const greeting = yield* read.call({ name: "greeting" }, Option.some("call-1"));
      assert.deepStrictEqual(greeting, {
        isError: false,
        text: '{"text":"hello","by":"ada"}',
      });
      const draft = yield* read.call({ name: "draft" }, Option.none());
      assert.deepStrictEqual(draft, {
        isError: true,
        text: '{"_tag":"NoteMissing","note":"draft"}',
      });
      const invalid = yield* read.call({ title: "greeting" }, Option.none());
      assert.isTrue(invalid.isError);
      assert.include(invalid.text, "Invalid parameters for tool 'read_note'");
      const exploded = yield* explode.call({}, Option.none());
      assert.deepStrictEqual(exploded, {
        isError: true,
        text: "The explode tool failed internally",
      });
    }),
  );

  it.effect("return a failure of a tool that returns its failures as an error result", () =>
    Effect.gen(function* () {
      const Lookup = Tool.make("lookup", {
        description: "Looks a key up.",
        parameters: Schema.Struct({ key: Schema.String }),
        success: Schema.String,
        failure: Schema.Struct({ reason: Schema.String }),
        failureMode: "return",
      });
      const kit = Toolkit.make(Lookup);
      const bound = yield* hostToolSet(kit).pipe(
        Effect.provide(
          kit.toLayer({
            lookup: ({ key }) =>
              key === "known" ? Effect.succeed("found") : Effect.fail({ reason: "nope" }),
          }),
        ),
      );
      const [lookup] = bound.tools;
      assert(lookup !== undefined);
      const found = yield* lookup.call({ key: "known" }, Option.none());
      assert.deepStrictEqual(found, { isError: false, text: "found" });
      const missing = yield* lookup.call({ key: "other" }, Option.none());
      assert.deepStrictEqual(missing, {
        isError: true,
        text: '{"reason":"nope"}',
      });
      const invalid = yield* lookup.call({ name: "known" }, Option.none());
      assert.isTrue(invalid.isError);
      assert.include(invalid.text, '"_tag":"AiError"');
    }),
  );

  it.effect("take parameters and return results in the JSON form of the tool's schemas", () =>
    Effect.gen(function* () {
      // `from` and `page` have an encoded side that differs from their type, so `handle` only
      // accepts them in the type-side encoded form; `budget` has a type-side form that isn't JSON.
      const Window = Schema.Struct({
        at: Schema.DateTimeUtc,
        limit: Schema.Option(Schema.Finite),
        from: Schema.DateTimeUtcFromString,
        page: Schema.OptionFromNullOr(Schema.Finite),
      });
      const Since = Tool.make("since", {
        description: "Lists notes since a time.",
        parameters: Window,
        success: Schema.Struct({ window: Window, at: Schema.DateTimeUtc }),
        failure: Schema.Struct({
          before: Schema.DateTimeUtc,
          budget: Schema.BigInt,
        }),
        failureMode: "return",
      });
      const Opaque = Tool.make("opaque", {
        description: "Returns a function.",
        success: Schema.Unknown,
      });
      const kit = Toolkit.make(Since, Opaque);
      const bound = yield* hostToolSet(kit).pipe(
        Effect.provide(
          kit.toLayer({
            since: (window) =>
              DateTime.isLessThan(window.at, DateTime.makeUnsafe(0))
                ? Effect.fail({ before: DateTime.makeUnsafe(0), budget: 5n })
                : Effect.succeed({
                    window,
                    at: DateTime.add(window.at, { days: 1 }),
                  }),
            opaque: () => Effect.succeed(() => "not JSON"),
          }),
        ),
      );
      const [since, opaque] = bound.tools;
      assert(since !== undefined && opaque !== undefined);
      const listed = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          properties: Schema.Struct({
            at: Schema.Struct({ type: Schema.String }),
          }),
        }),
      )(since.parameters);
      assert.strictEqual(listed.properties.at.type, "string", "the listed schema is the JSON form");
      const input = {
        at: "2026-11-12T00:00:00.000Z",
        limit: { _tag: "Some", value: 3 },
        from: "2026-11-01T00:00:00.000Z",
        page: 2,
      };
      const found = yield* since.call(input, Option.none());
      assert.deepStrictEqual(found, {
        isError: false,
        text:
          '{"window":{"at":"2026-11-12T00:00:00.000Z","limit":{"_tag":"Some","value":3},' +
          '"from":"2026-11-01T00:00:00.000Z","page":2},"at":"2026-11-13T00:00:00.000Z"}',
      });
      const before = {
        at: "1969-12-31T23:59:59.999Z",
        limit: { _tag: "None" },
        from: input.from,
        page: null,
      };
      const early = yield* since.call(before, Option.none());
      assert.deepStrictEqual(early, {
        isError: true,
        text: '{"before":"1970-01-01T00:00:00.000Z","budget":"5"}',
      });
      const invalid = yield* since.call({ at: "yesterday" }, Option.none());
      assert.isTrue(invalid.isError);
      // A tool that returns its failures returns invalid parameters as the encoded `AiError`.
      assert.include(invalid.text, '"_tag":"ToolParameterValidationError"');
      assert.include(invalid.text, "Expected a valid UTC DateTime string");
      const { records, layer } = collectLogs(["Error"]);
      const notJson = yield* opaque.call({}, Option.none()).pipe(Effect.provide(layer));
      assert.deepStrictEqual(notJson, {
        isError: true,
        text: "The opaque tool returned a result that is not JSON",
      });
      assert.deepStrictEqual(
        records.map(({ message }) => message),
        [
          [
            "Usine tool returned a result that is not JSON",
            { tool: "opaque", message: "Expected JSON value" },
          ],
        ],
      );
    }),
  );

  it.effect("keep names that a harness carries and alias the rest stably", () =>
    Effect.gen(function* () {
      const Named = (name: string) => Tool.make(name);
      const kit = Toolkit.make(
        Named("read_note"),
        Named("notes.read"),
        Named("bash"),
        Named("x".repeat(70)),
      );
      const bound = yield* hostToolSet(kit).pipe(
        Effect.provide(
          kit.toLayer({
            read_note: () => Effect.void,
            "notes.read": () => Effect.void,
            bash: () => Effect.void,
            ["x".repeat(70)]: () => Effect.void,
          }),
        ),
      );
      const rule = { maxLength: 52, reserved: new Set(["bash"]) };
      const { records, layer } = collectLogs(["Info", "Warn"]);
      const names = yield* hostToolNames(bound, rule).pipe(Effect.provide(layer));
      assert.deepStrictEqual(
        records.map(({ level, message }) => ({ level, message })),
        ["notes.read", "bash", "x".repeat(70)].map((tool) => ({
          level: "Info" as const,
          message: ["Aliased a usine tool name", { tool, alias: names.alias(tool) }],
        })),
      );
      const again = yield* hostToolNames(bound, rule);
      assert.strictEqual(names.alias("read_note"), "read_note");
      for (const name of ["notes.read", "bash", "x".repeat(70)]) {
        const alias = names.alias(name);
        assert.notStrictEqual(alias, name);
        assert.match(alias, /^[A-Za-z0-9_-]{1,52}$/);
        assert.strictEqual(again.alias(name), alias, "the alias is stable");
        assert.deepStrictEqual(names.name(alias), Option.some(name));
      }
      assert.match(names.alias("notes.read"), /^notes_read_/);
      assert.deepStrictEqual(names.name("unknown"), Option.none());
      const call = callHostTool(bound, names);
      const aliased = yield* call(names.alias("bash"), Option.some({}), Option.none());
      assert.deepStrictEqual(aliased, {
        isError: false,
        text: "null",
      });
      const unknown = yield* call("unknown", Option.some({}), Option.none());
      assert.deepStrictEqual(unknown, {
        isError: true,
        text: "No usine tool is named unknown",
      });
      // Parsing reads an out-of-range number as `Infinity`, which isn't JSON.
      records.length = 0;
      const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        '{"n":1e999}',
      );
      const outOfRange = yield* call("read_note", decodeHostToolInput(parsed), Option.none()).pipe(
        Effect.provide(layer),
      );
      assert.deepStrictEqual(outOfRange, {
        isError: true,
        text: "The tool input is not JSON",
      });
      assert.deepStrictEqual(
        records.map(({ level, message }) => ({ level, message })),
        [
          {
            level: "Warn",
            message: [
              "Session called a usine tool with an input that is not JSON",
              { tool: "read_note" },
            ],
          },
        ],
      );
      const clash = yield* Effect.exit(
        hostToolNames({ tools: [...bound.tools, ...bound.tools] }, rule),
      );
      assert(Exit.isFailure(clash), "two tools that share a name share an alias");
    }),
  );
});

const role = (hostTools: boolean) =>
  RoleSpec.make({
    name: RoleName.make("tool-probe"),
    placement: RolePlacements.make({
      placements: ["orchestrator"],
      reason: "The tool probe runs on the orchestrator",
    }),
    credential: Option.none(),
    nativeTools: false,
    hostTools,
    persistence: "saved",
    interventions: false,
    output: "text",
  });

const spec = (harness: string, hostTools: boolean) => {
  const brain = BrainSpec.make({
    harness: Harness.make(harness),
    model: ModelId.make("probe"),
    effort: "low",
  });
  return SessionSpec.make({
    session: RoleSession.make({
      id: AgentSessionId.make(`tools-${harness}`),
      role: role(hostTools).name,
      agent: AgentName.make("developer"),
      brain,
    }),
    admitted: AdmittedBrain.make({
      role: role(hostTools),
      brain,
      context: AdmissionContext.make({
        placement: "orchestrator",
        credential: "gateway",
      }),
      pool: Option.none(),
    }),
    host: LocalProcess.make(),
    worker: WorkerName.make("orchestrator"),
    machine: Option.none(),
    cwd: WorkingDirectory.make("/srv/usine"),
    environment: {},
  });
};

/** A runtime that reports the usine tools that each open received, instead of opening. */
const reporting = (id: Harness): HarnessRuntime => ({
  id,
  stop: () => Effect.void,
  preflight: checkedPreflight(() => Effect.void),
  open: openWithTools((opened, _start, _policy, served) =>
    Effect.fail(
      AgentResultError.make({
        sessionId: Option.some(opened.session.id),
        message: `opened with [${served.tools.map(({ name }) => name).join(",")}]`,
      }),
    ),
  ),
});

describe("usine tool sets through the registry", () => {
  it.effect("pass a toolkit only to a role that runs one, on a harness that serves it", () =>
    Effect.gen(function* () {
      const harnesses = yield* Harnesses;
      const open = (selected: SessionSpec, withTools: boolean) =>
        Effect.gen(function* () {
          const runtime = yield* harnesses.runtime(selected.session.brain.harness);
          const policy = yield* continuationPolicy(selected, "Probe", RestartState.make({}));
          const start = StartPrompt.make({ text: "Probe" });
          return yield* withTools
            ? runtime.open(selected, start, policy, tools)
            : runtime.open(selected, start, policy);
        }).pipe(
          Effect.scoped,
          Effect.provide(Layer.merge(handlers, Layer.succeed(Member)({ login: "ada" }))),
          Effect.flip,
        );
      for (const harness of ["claude", "pi"]) {
        const opened = yield* open(spec(harness, true), true);
        assert.strictEqual(opened.message, "opened with [read_note,explode]", harness);
        const missing = yield* open(spec(harness, true), false);
        assert.include(missing.message, "runs a usine tool set, but its session opened without");
        const extra = yield* open(spec(harness, false), true);
        assert.include(extra.message, "runs no usine tool set, but its session opened with one");
      }
      const codex = yield* open(spec("codex", true), true);
      assert.include(
        codex.message,
        "lacks usine-tools (The Codex adapter passes no usine tool set to a session until step 19",
      );
    }).pipe(Effect.provide(Harnesses.layerFrom(catalog, catalog.ids.map(reporting)))),
  );
});
