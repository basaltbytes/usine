import { assert } from "@effect/vitest";
import { type BrainSpec } from "@usine/core/agent/brain";
import { AgentSessionId, type HarnessSession } from "@usine/core/agent/session";
import { type Brand, Effect, Layer, Option, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import type { CredentialRoute } from "../../src/harness/capability.ts";
import {
  runSupervisorTurn,
  SupervisorSeat,
  SupervisorTurn,
} from "../../src/harness/supervisor/turn.ts";
import type { Transcript } from "../replay/transcript.ts";
import { type ToolProvider, toolFixture } from "./host-tools.ts";

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

/** The member's two messages: the first calls one operator tool, the second needs the first. */
export const supervisorMessages = [
  "Call the overview tool once, then reply with exactly the ID of the run that waits for " +
    "approval. Do not approve it and call no other tool.",
  `Reply with exactly the run ID from your previous answer, a space, and the word ${RESUMED}. ` +
    "Call no tools.",
] as const;

/** The credential route that each harness's recorded supervisor traffic used. */
const recordedRoutes = {
  claude: "gateway-subscription",
  pi: "gateway",
} satisfies Record<ToolProvider, CredentialRoute>;

/** The two turns of the supervisor scenario on `provider`, and the recorded traffic. */
export const runSupervisorScenario = (provider: ToolProvider, mode: "record" | "replay") =>
  Effect.gen(function* () {
    const fixture = yield* toolFixture(provider, "supervisor", mode);
    const { host, worker, cwd, environment } = fixture.request;
    const brain: BrainSpec = fixture.request.session.brain;
    const seat = SupervisorSeat.make({
      host,
      worker,
      cwd,
      environment,
      credential: recordedRoutes[provider],
    });
    // The recorded traffic names the session in process and pid file paths.
    const session = AgentSessionId.make("replay-parent:child:1");
    const turn = (message: string, saved: Option.Option<HarnessSession>) =>
      runSupervisorTurn(
        SupervisorTurn.make({ session, brain, seat, saved, message }),
        operatorTools,
      );
    const replies = yield* Effect.gen(function* () {
      const first = yield* turn(supervisorMessages[0], Option.none());
      const second = yield* turn(supervisorMessages[1], Option.some(first.saved));
      return [first, second] as const;
    }).pipe(
      Effect.provide(Layer.merge(operatorToolHandlers, fixture.harnesses)),
      fixture.tape.guard,
    );
    yield* fixture.save;
    const tape = fixture.tape;
    const entries: Transcript["entries"] =
      tape.source === "record" ? tape.entries : tape.source.entries;
    assert(entries.length > 0, "the scenario recorded traffic");
    return { replies, entries };
  });
