import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option, Result, Schema } from "effect";
import { Agent, AgentPersona, AgentName } from "../src/agent/agent.ts";
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
  HarnessSession,
  HarnessSessionId,
} from "../src/agent/session.ts";
import { AttemptTask, AttemptId } from "../src/attempt/attempt.ts";
import * as AttemptChannel from "../src/attempt/channel.ts";
import { AgentFailure, ChildSessionBudgetFailure } from "../src/attempt/failure.ts";
import { RepositoryName, CommitSha, RepositoryRevision } from "../src/repository.ts";
import { Comment, Commit, PullRequest, StepResult } from "../src/step/result.ts";

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

const EnvelopeJson = Schema.fromJsonString(AttemptChannel.Envelope);

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
  resume: Option.none(),
  preparedAt: Option.some(DateTime.makeUnsafe("2026-08-30T11:59:00Z")),
});

describe("attempt channel", () => {
  it("round-trips a final envelope through JSON", () => {
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
            new PullRequest({ number: 71, url: new URL("https://github.com/acme/demo/pull/71") }),
            new Comment({
              url: new URL("https://github.com/acme/demo/pull/71#issuecomment-1"),
              kind: "issue-comment",
            }),
          ],
        }),
      }),
    });

    const encoded = Schema.encodeSync(EnvelopeJson)(envelope);
    const decoded = Schema.decodeUnknownSync(EnvelopeJson)(encoded, {
      onExcessProperty: "error",
    });

    assert.deepStrictEqual(decoded, envelope);
  });

  it("round-trips a child-session budget failure through JSON", () => {
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

    const encoded = Schema.encodeSync(EnvelopeJson)(envelope);
    const decoded = Schema.decodeUnknownSync(EnvelopeJson)(encoded, {
      onExcessProperty: "error",
    });
    assert.deepStrictEqual(decoded, envelope);
  });

  it("round-trips a child-addressed operator message through JSON", () => {
    const envelope = new AttemptChannel.InboundEnvelope({
      operator: "operator",
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId: spec.attemptId,
      sequence: AttemptChannel.Sequence.make(3),
      sentAt: DateTime.makeUnsafe("2026-08-30T12:00:02Z"),
      target: new AttemptChannel.ChildTarget({
        sessionId: AgentSessionId.make("parent-1:child:1"),
      }),
      payload: new AttemptChannel.OperatorMessage({ message: "Rebase onto main before you push." }),
    });

    const encoded = Schema.encodeSync(EnvelopeJson)(envelope);
    const decoded = Schema.decodeUnknownSync(EnvelopeJson)(encoded, {
      onExcessProperty: "error",
    });

    assert.deepStrictEqual(decoded, envelope);
  });

  it("defaults an inbound frame to the parent target and round-trips a Release", () => {
    const envelope = new AttemptChannel.InboundEnvelope({
      operator: "operator",
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId: spec.attemptId,
      sequence: AttemptChannel.Sequence.make(4),
      sentAt: DateTime.makeUnsafe("2026-08-30T12:00:03Z"),
      target: new AttemptChannel.ParentTarget(),
      payload: new AttemptChannel.Release(),
    });

    const encoded = Schema.encodeSync(EnvelopeJson)(envelope);
    const decoded = Schema.decodeUnknownSync(EnvelopeJson)(encoded, {
      onExcessProperty: "error",
    });

    assert.deepStrictEqual(decoded, envelope);
  });

  it("rejects superseded protocol versions on the live channel", () => {
    const outbound = Schema.encodeSync(AttemptChannel.Envelope)(
      new AttemptChannel.OutboundEnvelope({
        version: AttemptChannel.PROTOCOL_VERSION,
        attemptId: spec.attemptId,
        sequence: AttemptChannel.Sequence.make(1),
        sentAt: DateTime.makeUnsafe("2026-08-30T12:00:00Z"),
        payload: new AttemptChannel.Interrupted(),
      }),
    );

    for (const version of [3, 4, 5] as const) {
      assert.throws(() =>
        Schema.decodeUnknownSync(AttemptChannel.Envelope)(
          { ...outbound, version },
          { onExcessProperty: "error" },
        ),
      );
    }
  });

  it("round-trips rate-limit reset dates through JSON", () => {
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

    const encoded = Schema.encodeSync(EnvelopeJson)(envelope);
    const decoded = Schema.decodeUnknownSync(EnvelopeJson)(encoded, {
      onExcessProperty: "error",
    });

    assert.deepStrictEqual(decoded, envelope);
  });

  it("rejects credentials smuggled into a RunSpec", () => {
    const raw = Schema.encodeSync(AttemptChannel.RunSpec)(spec);

    assert.throws(() =>
      Schema.decodeUnknownSync(AttemptChannel.RunSpec)(
        { ...raw, githubToken: "must-never-cross-the-channel" },
        { onExcessProperty: "error" },
      ),
    );
  });

  it("reads older launch records and round-trips saved harness session metadata", () => {
    const session = new ParentSession({
      id: AgentSessionId.make("parent"),
      agent: agent.name,
      brain: agent.brain,
    });
    const legacy = Schema.encodeSync(SessionStarted)(new SessionStarted({ session }));
    assert(Option.isNone(Schema.decodeUnknownSync(SessionStarted)(legacy).harnessSession));
    const storedSpec = Object.fromEntries(
      Object.entries(Schema.encodeSync(AttemptChannel.RunSpec)(spec)).filter(
        ([key]) => key !== "preparedAt",
      ),
    );
    assert(Option.isNone(Schema.decodeUnknownSync(AttemptChannel.RunSpec)(storedSpec).preparedAt));
    const started = new SessionStarted({
      session,
      harnessSession: Option.some(
        new HarnessSession({ id: HarnessSessionId.make("native-1"), cwd: "/worker/repo" }),
      ),
    });
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(SessionStarted)(Schema.encodeSync(SessionStarted)(started)),
      started,
    );
    assert.throws(() => HarnessSessionId.make(""));
    assert.throws(() => new HarnessSession({ id: HarnessSessionId.make("native-1"), cwd: "" }));
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
