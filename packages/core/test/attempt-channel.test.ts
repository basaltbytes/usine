import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option, Result, Schema } from "effect";
import { Agent, AgentPersona } from "../src/agent/agent.ts";
import { BrainSpec, ModelId } from "../src/agent/brain.ts";
import {
  AgentSessionId,
  ChildSessionBudget,
  ChildSessionCount,
  ParentSession,
  PoolRateLimitsUpdated,
  RateLimitsSnapshot,
  RateLimitWindow,
  SessionStarted,
} from "../src/agent/session.ts";
import { AttemptTask } from "../src/attempt/attempt.ts";
import * as AttemptChannel from "../src/attempt/channel.ts";
import { AgentFailure, ChildSessionBudgetFailure } from "../src/attempt/failure.ts";
import { AgentName, AttemptId, RepositoryName } from "../src/ids.ts";
import { CommitSha, RepositoryRevision } from "../src/repository.ts";
import { Commit, StepResult } from "../src/step/result.ts";

const agent = new Agent({
  name: AgentName.make("developer"),
  brain: new BrainSpec({
    harness: "claude",
    model: ModelId.make("claude-sonnet-4-6"),
    effort: "high",
  }),
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the task and sign every GitHub comment."),
});
const parentModel = ModelId.make("anthropic/claude-opus-4-6");

const spec = new AttemptChannel.RunSpec({
  attemptId: AttemptId.make("attempt-1"),
  repository: RepositoryName.make("basaltbytes/usine"),
  revision: RepositoryRevision.make("main"),
  baseCommit: CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
  payload: { number: 30, title: "Agent layer" },
  task: AttemptTask.make("Implement the issue"),
  agent,
  parentModel: Option.some(parentModel),
  maxChildren: ChildSessionBudget.make(4),
  parentEffort: "high",
});

describe("attempt channel v4", () => {
  it("round-trips a final envelope through its framed JSON schema", () => {
    const envelope = new AttemptChannel.OutboundEnvelope({
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId: spec.attemptId,
      sequence: AttemptChannel.Sequence.make(1),
      sentAt: DateTime.makeUnsafe("2026-08-30T12:00:00Z"),
      payload: new AttemptChannel.Final({
        result: new StepResult({
          message: "Done",
          facts: [
            new Commit({
              sha: CommitSha.make("fedcba9876543210fedcba9876543210fedcba98"),
              summary: "Implement executor",
            }),
          ],
        }),
      }),
    });

    const encoded = Schema.encodeSync(AttemptChannel.EnvelopeFromJson)(envelope);
    const decoded = Schema.decodeUnknownSync(AttemptChannel.EnvelopeFromJson)(encoded, {
      onExcessProperty: "error",
    });

    assert.deepStrictEqual(decoded, envelope);
  });

  it("round-trips a child-session budget failure through its framed JSON schema", () => {
    const envelope = new AttemptChannel.OutboundEnvelope({
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId: spec.attemptId,
      sequence: AttemptChannel.Sequence.make(2),
      sentAt: DateTime.makeUnsafe("2026-08-30T12:00:01Z"),
      payload: new AttemptChannel.Failed({
        failure: new ChildSessionBudgetFailure({
          maxChildren: spec.maxChildren,
          attemptedChildren: ChildSessionCount.make(5),
        }),
      }),
    });

    const encoded = Schema.encodeSync(AttemptChannel.EnvelopeFromJson)(envelope);
    const decoded = Schema.decodeUnknownSync(AttemptChannel.EnvelopeFromJson)(encoded, {
      onExcessProperty: "error",
    });
    assert.deepStrictEqual(decoded, envelope);
  });

  it("rejects protocol-v3 frames on the live channel", () => {
    const start = Schema.encodeSync(AttemptChannel.InputFrame)(
      new AttemptChannel.Start({ version: AttemptChannel.PROTOCOL_VERSION, spec }),
    );
    const outbound = Schema.encodeSync(AttemptChannel.Envelope)(
      new AttemptChannel.OutboundEnvelope({
        version: AttemptChannel.PROTOCOL_VERSION,
        attemptId: spec.attemptId,
        sequence: AttemptChannel.Sequence.make(1),
        sentAt: DateTime.makeUnsafe("2026-08-30T12:00:00Z"),
        payload: new AttemptChannel.Interrupted(),
      }),
    );

    assert.throws(() =>
      Schema.decodeUnknownSync(AttemptChannel.InputFrame)(
        { ...start, version: 3 },
        { onExcessProperty: "error" },
      ),
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(AttemptChannel.Envelope)(
        { ...outbound, version: 3 },
        { onExcessProperty: "error" },
      ),
    );
  });

  it("round-trips rate-limit reset dates through its framed JSON schema", () => {
    const session = new ParentSession({
      id: AgentSessionId.make("parent-1"),
      agent: agent.name,
      brain: new BrainSpec({ harness: "pi", model: parentModel, effort: "high" }),
    });
    const envelope = new AttemptChannel.OutboundEnvelope({
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId: spec.attemptId,
      sequence: AttemptChannel.Sequence.make(1),
      sentAt: DateTime.makeUnsafe("2026-08-30T12:00:00Z"),
      payload: new AttemptChannel.SessionEvent({
        event: new PoolRateLimitsUpdated({
          session,
          pool: "chatgptPlan",
          rateLimits: new RateLimitsSnapshot({
            limitId: Option.some("codex"),
            limitName: Option.some("ChatGPT"),
            primary: Option.some(
              new RateLimitWindow({
                usedPercent: 24,
                windowDurationMinutes: Option.some(300),
                resetsAt: Option.some(DateTime.makeUnsafe("2026-09-07T02:25:59Z")),
              }),
            ),
            secondary: Option.some(
              new RateLimitWindow({
                usedPercent: 0,
                windowDurationMinutes: Option.none(),
                resetsAt: Option.none(),
              }),
            ),
          }),
        }),
      }),
    });

    const encoded = Schema.encodeSync(AttemptChannel.OutboundEnvelopeFromJson)(envelope);
    const decoded = Schema.decodeUnknownSync(AttemptChannel.OutboundEnvelopeFromJson)(encoded, {
      onExcessProperty: "error",
    });

    assert.deepStrictEqual(decoded, envelope);
  });

  it("rejects credentials smuggled into a RunSpec frame", () => {
    const encoded = Schema.encodeSync(AttemptChannel.InputFrameFromJson)(
      new AttemptChannel.Start({ version: AttemptChannel.PROTOCOL_VERSION, spec }),
    );
    const raw = JSON.parse(encoded);
    raw.spec.githubToken = "must-never-cross-the-channel";

    assert.throws(() =>
      Schema.decodeUnknownSync(AttemptChannel.InputFrameFromJson)(JSON.stringify(raw), {
        onExcessProperty: "error",
      }),
    );
  });

  describe("outbound protocol reducer", () => {
    const outbound = (
      sequence: number,
      payload: AttemptChannel.OutboundPayload,
      attemptId = spec.attemptId,
    ) =>
      new AttemptChannel.OutboundEnvelope({
        version: AttemptChannel.PROTOCOL_VERSION,
        attemptId,
        sequence: AttemptChannel.Sequence.make(sequence),
        sentAt: DateTime.makeUnsafe("2026-08-30T12:00:00Z"),
        payload,
      });
    const started = new AttemptChannel.Started({ parentModel });
    const sessionEvent = new AttemptChannel.SessionEvent({
      event: new SessionStarted({
        session: new ParentSession({
          id: AgentSessionId.make("parent-1"),
          agent: agent.name,
          brain: new BrainSpec({ harness: "pi", model: parentModel, effort: "high" }),
        }),
      }),
    });
    const interruptedTerminal = new AttemptChannel.Interrupted();

    const admitAll = (envelopes: ReadonlyArray<AttemptChannel.OutboundEnvelope>) => {
      let progress = AttemptChannel.initialProgress;
      for (const envelope of envelopes) {
        const admitted = AttemptChannel.admit(progress, spec.attemptId, envelope);
        if (Result.isFailure(admitted)) return admitted;
        progress = admitted.success;
      }
      return Result.succeed(progress);
    };

    it("admits a legal Started → session event → terminal flow", () => {
      const outcome = admitAll([
        outbound(1, started),
        outbound(2, sessionEvent),
        outbound(3, interruptedTerminal),
      ]);
      assert(Result.isSuccess(outcome));
      assert.strictEqual(outcome.success.state, "Terminal");
    });

    it("rejects a frame for another Attempt", () => {
      const outcome = admitAll([outbound(1, started, AttemptId.make("attempt-2"))]);
      assert(Result.isFailure(outcome));
      assert.match(outcome.failure.message, /another Attempt/u);
    });

    it("rejects a non-contiguous sequence", () => {
      const outcome = admitAll([outbound(1, started), outbound(3, sessionEvent)]);
      assert(Result.isFailure(outcome));
      assert.match(outcome.failure.message, /non-contiguous/u);
    });

    it("rejects a first frame that is not Started", () => {
      const outcome = admitAll([outbound(1, sessionEvent)]);
      assert(Result.isFailure(outcome));
      assert.match(outcome.failure.message, /begin with a Started or Failed/u);
    });

    it("admits a launch failure as the first and terminal frame", () => {
      const outcome = admitAll([
        outbound(
          1,
          new AttemptChannel.Failed({
            failure: new AgentFailure({ message: "Unknown model" }),
          }),
        ),
      ]);
      assert(Result.isSuccess(outcome));
      assert.strictEqual(outcome.success.state, "Terminal");
    });

    it("rejects a duplicate Started", () => {
      const outcome = admitAll([outbound(1, started), outbound(2, started)]);
      assert(Result.isFailure(outcome));
      assert.match(outcome.failure.message, /more than one Started/u);
    });

    it("rejects an envelope after the terminal envelope", () => {
      const outcome = admitAll([
        outbound(1, started),
        outbound(2, interruptedTerminal),
        outbound(3, sessionEvent),
      ]);
      assert(Result.isFailure(outcome));
      assert.match(outcome.failure.message, /after its terminal envelope/u);
    });
  });
});
