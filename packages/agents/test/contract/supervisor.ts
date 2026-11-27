import { replayContainerHost } from "./container-seat.ts";
import { assert } from "@effect/vitest";
import { type BrainSpec } from "@usine/core/agent/brain";
import {
  type AgentSessionEvent,
  AgentSessionId,
  type HarnessSession,
  type SessionTokensUpdated,
} from "@usine/core/agent/session";
import { type Brand, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import type { CredentialRoute } from "../../src/harness/capability.ts";
import {
  runSupervisorTurn,
  type SupervisorReply,
  SupervisorSeat,
  SupervisorTurn,
} from "../../src/harness/supervisor/turn.ts";
import type { FixtureOptions } from "../replay/fixture.ts";
import type { Transcript } from "../replay/transcript.ts";
import { listedTools, type ToolProvider, toolFixture } from "./host-tools.ts";

/** The run that the `overview` tool reports as waiting for approval. */
export const WAITING_RUN = "run-7431";
/** The word that the second turn adds, so that its answer differs from the first. */
export const RESUMED = "RESUMED";

export class RunNotFound extends Schema.TaggedError<
  RunNotFound,
  Brand.Brand<"@usine/agents/test/RunNotFound">
>("@usine/agents/test/RunNotFound")("RunNotFound", { runId: Schema.String }) {}

/** Reads the factory, as the operator API's `overview` operation does. */
export const Overview = Tool.make("overview", {
  description: "Lists the runs that wait for an operator. Requires read permission.",
  success: Schema.Struct({
    waiting: Schema.Array(Schema.Struct({ runId: Schema.String, loop: Schema.String })),
  }),
});

/** Changes the factory, as the operator API's `approve` operation does. */
export const Approve = Tool.make("approve", {
  description: "Approves a run that waits for approval. Requires operate permission.",
  parameters: Schema.Struct({ runId: Schema.String }),
  success: Schema.Struct({ approved: Schema.String }),
  failure: RunNotFound,
});

/** The one operator toolkit that every harness serves in the supervisor scenario. */
export const operatorTools = Toolkit.make(Overview, Approve);

/** The toolkit's handlers. Approving any run other than the waiting one fails. */
export const operatorToolHandlers = operatorTools.toLayer({
  overview: () => Effect.succeed({ waiting: [{ runId: WAITING_RUN, loop: "triage" }] }),
  approve: ({ runId }) =>
    runId === WAITING_RUN
      ? Effect.succeed({ approved: runId })
      : Effect.fail(RunNotFound.make({ runId })),
});

/** The repository file that the first turn reads, relative to the session's working directory. */
export const SOURCE_FILE = "acme/demo/RUNBOOK.md";
/** The code word that only `SOURCE_FILE` holds. */
export const SOURCE_WORD = "HERON-2207";

/** The member's two messages: the first reads the source and calls one operator tool, the second needs the first. */
export const supervisorMessages = [
  `Read the file ${SOURCE_FILE}, then call the overview tool once. Reply with exactly the code ` +
    "word that the file names, a space, and the ID of the run that waits for approval. Do not " +
    "approve the run, and do not change any file.",
  `Reply with exactly the run ID from your previous answer, a space, and the word ${RESUMED}. ` +
    "Call no tools.",
] as const;

/**
 * The harnesses whose descriptors admit the supervisor role. OpenCode serves usine tool sets too,
 * but doesn't run at the orchestrator.
 */
export const supervisorProviders = [
  "claude",
  "pi",
  "codex",
] as const satisfies ReadonlyArray<ToolProvider>;
export type SupervisorProvider = (typeof supervisorProviders)[number];

/** The credential route that each harness's recorded supervisor traffic used. */
const recordedRoutes = {
  claude: "gateway-subscription",
  pi: "gateway",
  codex: "gateway-subscription",
} satisfies Record<SupervisorProvider, CredentialRoute>;

/** The names under which `provider` lists the toolkit's tools. */
const operatorNames = (provider: SupervisorProvider) =>
  Object.keys(operatorTools.tools).map((name) =>
    provider === "claude" ? `mcp__usine__${name}` : provider === "codex" ? `usine.${name}` : name,
  );

/**
 * The harness tools that each recorded session lists: Claude Code's and Pi's read and search
 * tools. Codex lists its own tools only in its model requests, which its traffic doesn't carry.
 */
const readTools = {
  claude: ["Glob", "Grep", "Read"],
  pi: ["find", "grep", "ls", "read"],
  codex: [],
} satisfies Record<SupervisorProvider, ReadonlyArray<string>>;

/** The tool with which each recorded session read the source file. */
const sourceReads = {
  claude: "Read",
  pi: "read",
  codex: "command",
} satisfies Record<SupervisorProvider, string>;

const started = (events: ReadonlyArray<AgentSessionEvent>) =>
  events.flatMap((event) => (event._tag === "ToolStarted" ? [event.tool] : []));
const finished = (events: ReadonlyArray<AgentSessionEvent>) =>
  events.flatMap((event) =>
    event._tag === "ToolFinished" ? [{ tool: event.tool, isError: event.isError }] : [],
  );

/** Checks the answers, tool events, offered tool lists, and session resume before saving or returning. */
const assertSupervisorOutcome = (
  provider: SupervisorProvider,
  replies: readonly [SupervisorReply, SupervisorReply],
  entries: Transcript["entries"],
): void => {
  const [first, second] = replies;
  assert.include(first.message, SOURCE_WORD, "the answer quotes the repository file");
  assert.include(first.message, WAITING_RUN);
  assert.deepStrictEqual(started(first.events), [sourceReads[provider], "overview"]);
  assert.deepStrictEqual(finished(first.events), [
    { tool: sourceReads[provider], isError: false },
    { tool: "overview", isError: false },
  ]);
  assert.strictEqual(first.events.at(-1)?._tag, "SessionFinished");

  assert(entries.length > 0, "the scenario recorded traffic");
  const listed = listedTools(provider, entries);
  assert.isNotEmpty(listed, "the recorded traffic shows the session's tool list");
  for (const offered of listed)
    assert.deepStrictEqual(
      [...offered].sort(),
      [...readTools[provider], ...operatorNames(provider)].sort(),
      "the session lists the harness's read and search tools and the operator tools",
    );

  assert.include(second.message, WAITING_RUN, "the second turn recalls the first");
  assert.include(second.message, RESUMED);
  assert.deepStrictEqual(started(second.events), []);
  assert.strictEqual(second.events.at(-1)?._tag, "SessionFinished");
  assert.strictEqual(second.saved.id, first.saved.id, "the second turn reopens the session");
  const reopened = second.events.find((event) => event._tag === "SessionStarted");
  assert(reopened?._tag === "SessionStarted");
  assert.deepStrictEqual(
    Option.map(reopened.harnessSession, ({ id }) => id),
    Option.some(first.saved.id),
  );
};

/** The two turns of the supervisor scenario on `provider`, and the recorded traffic. */
export const runSupervisorScenario = (
  provider: SupervisorProvider,
  mode: "record" | "replay",
  options: FixtureOptions = {},
) =>
  Effect.gen(function* () {
    const fixture = yield* toolFixture(provider, "supervisor", mode, options);
    const { worker, cwd, environment } = fixture.request;
    const host = yield* replayContainerHost(provider, fixture.tape);
    // The session reads the instance's source from its working directory, one directory per
    // repository, as the supervisor sandbox mounts it.
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${cwd}/acme/demo`, { recursive: true });
    yield* fs.writeFileString(
      `${cwd}/${SOURCE_FILE}`,
      `# Runbook\n\nThe code word for this repository is ${SOURCE_WORD}.\n`,
    );
    const brain: BrainSpec = fixture.request.session.brain;
    const seat = SupervisorSeat.make({
      host,
      worker,
      cwd,
      environment,
      credential: recordedRoutes[provider],
      restored: true,
    });
    // The recorded traffic names the session in process and pid file paths.
    const session = AgentSessionId.make("replay-parent:child:1");
    const turn = (
      message: string,
      saved: Option.Option<HarnessSession>,
      usage: Option.Option<SessionTokensUpdated>,
    ) =>
      runSupervisorTurn(
        SupervisorTurn.make({ session, brain, seat, saved, usage, message }),
        operatorTools,
      );
    const replies = yield* Effect.gen(function* () {
      const first = yield* turn(supervisorMessages[0], Option.none(), Option.none());
      const second = yield* turn(supervisorMessages[1], Option.some(first.saved), first.usage);
      return [first, second] as const;
    }).pipe(
      Effect.provide(Layer.merge(operatorToolHandlers, fixture.harnesses)),
      fixture.tape.guard,
    );
    const tape = fixture.tape;
    const entries: Transcript["entries"] =
      tape.source === "record" ? tape.entries : tape.source.entries;
    assertSupervisorOutcome(provider, replies, entries);
    yield* fixture.save;
    return { replies, entries, brain };
  });
