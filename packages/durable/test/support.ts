import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert } from "@effect/vitest";
import { type ChildHost, LocalProcess } from "@usine/agents/child-host";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { type AgentSessionEvent, ChildSessionBudget } from "@usine/core/agent/session";
import { AttemptId, AttemptTask } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { CommitSha, RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Option, Result } from "effect";
import { AttemptRequest } from "../src/attempt-runtime.ts";
import { PARENT_MODEL } from "../src/testing.ts";

const agent = new Agent({
  name: AgentName.make("developer"),
  brain: new BrainSpec({
    harness: "claude",
    model: ModelId.make("claude-sonnet-4-6"),
    effort: "high",
  }),
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the issue carefully."),
});

/** The environment children must receive instead of the test process's own. */
export const workerEnvironment = { PATH: "/usr/bin:/bin", GH_CONFIG_DIR: "/tmp/usine-gh" };

export const attemptRequest = (
  attemptId: string,
  maxChildren = 3,
  host: ChildHost = new LocalProcess(),
) =>
  new AttemptRequest({
    spec: new AttemptChannel.RunSpec({
      attemptId: AttemptId.make(attemptId),
      repository: RepositoryName.make("basaltbytes/usine"),
      revision: RepositoryRevision.make("main"),
      baseCommit: CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
      payload: { number: 176 },
      task: AttemptTask.make("Fix the flaky durable test."),
      agent,
      parentModel: Option.some(PARENT_MODEL),
      maxChildren: ChildSessionBudget.make(maxChildren),
      parentEffort: "medium",
      resume: Option.none(),
      preparedAt: Option.some(DateTime.makeUnsafe("2026-10-19T12:00:00Z")),
    }),
    worker: WorkerName.make("local"),
    cwd: "/workspace/usine",
    host,
    environment: workerEnvironment,
  });

/** A temporary folder for one test's storage, removed with the scope. */
export const temporaryDatabase = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "usine-durable-"))),
  (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
).pipe(Effect.map((directory) => join(directory, "durable.sqlite")));

/** Records envelopes like the transcript store: one row per direction and sequence. */
export const recordingSink = () => {
  const recorded: Array<{
    readonly direction: AttemptChannel.Direction;
    readonly envelope: AttemptChannel.Envelope;
  }> = [];
  const sink: AttemptChannel.Sink = {
    append: (direction, envelope) =>
      Effect.sync(() => {
        if (
          recorded.some(
            (row) => row.direction === direction && row.envelope.sequence === envelope.sequence,
          )
        ) {
          return;
        }
        recorded.push({ direction, envelope });
      }),
    salvage: () => Effect.void,
  };
  const outbound = () =>
    recorded.flatMap(({ direction, envelope }) =>
      direction === "outbound" && envelope._tag === "OutboundEnvelope" ? [envelope] : [],
    );
  const inbound = () =>
    recorded.flatMap(({ direction, envelope }) =>
      direction === "inbound" && envelope._tag === "InboundEnvelope" ? [envelope] : [],
    );
  return { sink, outbound, inbound };
};

/** Folds the channel law over every outbound envelope and requires one terminal envelope at the end. */
export const assertAdmitted = (
  attemptId: string,
  envelopes: ReadonlyArray<AttemptChannel.OutboundEnvelope>,
) => {
  let progress = AttemptChannel.initialProgress;
  for (const envelope of envelopes) {
    const admitted = AttemptChannel.admit(progress, AttemptId.make(attemptId), envelope);
    if (Result.isFailure(admitted)) {
      assert.fail(`${admitted.failure.message}: ${admitted.failure.detail}`);
    }
    progress = admitted.success;
  }
  assert.strictEqual(progress.state, "Terminal");
};

/** A readable trace of the relayed payloads: envelope tags, session events with their session role. */
export const trace = (envelopes: ReadonlyArray<AttemptChannel.OutboundEnvelope>) =>
  envelopes.flatMap(({ payload }) => {
    if (payload._tag !== "SessionEvent") return [payload._tag];
    const event: AgentSessionEvent = payload.event;
    if (event._tag === "SessionTokensUpdated" || event._tag === "PoolRateLimitsUpdated") return [];
    const role = event.session._tag === "ParentSession" ? "parent" : "child";
    const tool =
      event._tag === "ToolStarted" || event._tag === "ToolFinished" ? `:${event.tool}` : "";
    return [`${role}.${event._tag}${tool}`];
  });
