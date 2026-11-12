import { assert, describe, it } from "@effect/vitest";
import { Effect, DateTime, Option, Result, Schema } from "effect";
import { Agent, AgentPersona, AgentName } from "../src/agent/agent.ts";
import { Harness, BrainSpec, ModelId } from "../src/agent/brain.ts";
import {
  AgentSessionId,
  AgentSession,
  ChildSession,
  EndpointName,
  sessionPool,
  ChildSessionBudget,
  ChildSessionCount,
  ParentSession,
  PoolRateLimitsUpdated,
  PoolLogin,
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
import { BotLogin } from "../src/worker.ts";
import { Comment, Commit, PullRequest, StepResult } from "../src/step/result.ts";

const agent = Agent.make({
  name: AgentName.make("developer"),
  brain: BrainSpec.make({
    harness: Harness.make("claude"),
    model: ModelId.make("claude-sonnet-4-6"),
    effort: "high",
  }),
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the task and sign every GitHub comment."),
});
const parentModel = ModelId.make("anthropic/claude-opus-4-6");

const EnvelopeJson = Schema.fromJsonString(AttemptChannel.Envelope);

const spec = AttemptChannel.RunSpec.make({
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
  botLogin: Option.some(BotLogin.make("usine-basaltbytes[bot]")),
});

describe("attempt channel", () => {
  it.effect("reads older delivery receipts and round-trips the forwarded child identity", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(AttemptChannel.InterventionState);
      assert.isTrue(Option.isNone((yield* decode({ held: false, paused: false })).forwardedTo));
      const forwarded = yield* decode({
        held: false,
        paused: false,
        queued: true,
        forwardedTo: "child-1",
      });
      assert.deepStrictEqual(forwarded.forwardedTo, Option.some(AgentSessionId.make("child-1")));
      const json = Schema.fromJsonString(AttemptChannel.InterventionState);
      const decodedValue6 = yield* Schema.encodeEffect(json)(forwarded);
      const decodedValue7 = yield* Schema.decodeEffect(json)(decodedValue6);
      assert.deepStrictEqual(decodedValue7, forwarded);
    }),
  );
  it.effect("reads a stored parent model and round-trips a start without a parent session", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(AttemptChannel.Started);
      const stored = yield* decode({ _tag: "Started", parentModel: "anthropic/claude-opus-4-6" });
      assert.deepStrictEqual(stored.parentModel, Option.some(parentModel));
      const absent = yield* decode({ _tag: "Started" });
      assert.isTrue(Option.isNone(absent.parentModel));
      const parentless = AttemptChannel.Started.make({});
      assert.isTrue(Option.isNone(parentless.parentModel));
      const json = Schema.fromJsonString(AttemptChannel.Started);
      const encoded = yield* Schema.encodeEffect(json)(parentless);
      const written = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(encoded);
      assert.deepStrictEqual(written, {
        _tag: "Started",
        parentModel: null,
        conflictingSalvage: null,
      });
      const roundTripped = yield* Schema.decodeEffect(json)(encoded);
      assert.deepStrictEqual(roundTripped, parentless);
    }),
  );
  it.effect("preserves legacy worker recoveries and round-trips initial confirmations", () =>
    Effect.gen(function* () {
      const notice = {
        _tag: "WorkerResponsive",
        worker: "remote",
        lastAnsweredAt: "2026-10-28T00:00:00Z",
      };
      const decode = Schema.decodeUnknownEffect(AttemptChannel.WorkerResponsive);
      assert.isTrue((yield* decode(notice)).recovered);
      const initial = yield* decode({ ...notice, recovered: false });
      assert.isFalse(initial.recovered);
      const json = Schema.fromJsonString(AttemptChannel.WorkerResponsive);
      const decodedValue4 = yield* Schema.encodeEffect(json)(initial);
      const decodedValue5 = yield* Schema.decodeEffect(json)(decodedValue4);
      assert.deepStrictEqual(decodedValue5, initial);
    }),
  );
  it.effect(
    "reads legacy worker notices as one failed probe and rejects invalid probe counts",
    () =>
      Effect.gen(function* () {
        const notice = {
          _tag: "WorkerUnresponsive",
          worker: "remote",
          lastAnsweredAt: "2026-10-28T00:00:00Z",
          reason: "SSH timed out",
        };
        const decode = Schema.decodeUnknownEffect(AttemptChannel.WorkerUnresponsive);
        assert.strictEqual((yield* decode(notice)).unansweredProbes, 1);
        assert.strictEqual((yield* decode({ ...notice, unansweredProbes: 3 })).unansweredProbes, 3);
        for (const unansweredProbes of [0, -1, 1.5])
          assert.strictEqual(
            (yield* Effect.flip(decode({ ...notice, unansweredProbes })))._tag,
            "SchemaError",
          );
      }),
  );
  it.effect("round-trips a final envelope through JSON", () =>
    Effect.gen(function* () {
      const envelope = AttemptChannel.OutboundEnvelope.make({
        version: AttemptChannel.PROTOCOL_VERSION,
        attemptId: spec.attemptId,
        sequence: AttemptChannel.Sequence.make(1),
        sentAt: DateTime.makeUnsafe("2026-08-30T12:00:00Z"),
        payload: AttemptChannel.Final.make({
          result: StepResult.make({
            message: "Done",
            facts: [
              Commit.make({
                sha: CommitSha.make("fedcba9876543210fedcba9876543210fedcba98"),
                summary: "Implement executor",
              }),
              PullRequest.make({
                number: 71,
                url: new URL("https://github.com/acme/demo/pull/71"),
              }),
              Comment.make({
                url: new URL("https://github.com/acme/demo/pull/71#issuecomment-1"),
                kind: "issue-comment",
                at: Option.some(DateTime.makeUnsafe("2026-08-30T11:58:00Z")),
              }),
            ],
          }),
        }),
      });

      const encoded = yield* Schema.encodeEffect(EnvelopeJson)(envelope);
      const decoded = yield* Schema.decodeEffect(EnvelopeJson)(encoded, {
        onExcessProperty: "error",
      });

      assert.deepStrictEqual(decoded, envelope);
    }),
  );

  it.effect("decodes a Comment fact stored without its time as none", () =>
    Effect.gen(function* () {
      const stored = {
        _tag: "Comment",
        url: "https://github.com/acme/demo/pull/71",
        kind: "review",
      };
      const comment = yield* Schema.decodeUnknownEffect(Comment)(stored);
      assert.isTrue(Option.isNone(comment.at));
      const decodedValue3 = yield* Schema.encodeEffect(Comment)(comment);
      assert.deepStrictEqual(decodedValue3, stored);
    }),
  );

  it.effect("round-trips a child-session budget failure through JSON", () =>
    Effect.gen(function* () {
      const envelope = AttemptChannel.OutboundEnvelope.make({
        version: AttemptChannel.PROTOCOL_VERSION,
        attemptId: spec.attemptId,
        sequence: AttemptChannel.Sequence.make(2),
        sentAt: DateTime.makeUnsafe("2026-08-30T12:00:01Z"),
        payload: AttemptChannel.Failed.make({
          failure: ChildSessionBudgetFailure.make({
            maxChildren: spec.maxChildren,
            attemptedChildren: ChildSessionCount.make(5),
          }),
        }),
      });

      const encoded = yield* Schema.encodeEffect(EnvelopeJson)(envelope);
      const decoded = yield* Schema.decodeEffect(EnvelopeJson)(encoded, {
        onExcessProperty: "error",
      });
      assert.deepStrictEqual(decoded, envelope);
    }),
  );

  it.effect("round-trips a child-addressed operator message through JSON", () =>
    Effect.gen(function* () {
      const envelope = AttemptChannel.InboundEnvelope.make({
        operator: "operator",
        version: AttemptChannel.PROTOCOL_VERSION,
        attemptId: spec.attemptId,
        sequence: AttemptChannel.Sequence.make(3),
        sentAt: DateTime.makeUnsafe("2026-08-30T12:00:02Z"),
        target: AttemptChannel.ChildTarget.make({
          sessionId: AgentSessionId.make("parent-1:child:1"),
        }),
        payload: AttemptChannel.OperatorMessage.make({
          message: "Rebase onto main before you push.",
        }),
      });

      const encoded = yield* Schema.encodeEffect(EnvelopeJson)(envelope);
      const decoded = yield* Schema.decodeEffect(EnvelopeJson)(encoded, {
        onExcessProperty: "error",
      });

      assert.deepStrictEqual(decoded, envelope);
    }),
  );

  it.effect("defaults an inbound frame to the parent target and round-trips a Release", () =>
    Effect.gen(function* () {
      const envelope = AttemptChannel.InboundEnvelope.make({
        operator: "operator",
        version: AttemptChannel.PROTOCOL_VERSION,
        attemptId: spec.attemptId,
        sequence: AttemptChannel.Sequence.make(4),
        sentAt: DateTime.makeUnsafe("2026-08-30T12:00:03Z"),
        target: AttemptChannel.ParentTarget.make(),
        payload: AttemptChannel.Release.make(),
      });

      const encoded = yield* Schema.encodeEffect(EnvelopeJson)(envelope);
      const decoded = yield* Schema.decodeEffect(EnvelopeJson)(encoded, {
        onExcessProperty: "error",
      });

      assert.deepStrictEqual(decoded, envelope);
    }),
  );

  it.effect("rejects superseded protocol versions on the live channel", () =>
    Effect.gen(function* () {
      const outbound = yield* Schema.encodeEffect(AttemptChannel.Envelope)(
        AttemptChannel.OutboundEnvelope.make({
          version: AttemptChannel.PROTOCOL_VERSION,
          attemptId: spec.attemptId,
          sequence: AttemptChannel.Sequence.make(1),
          sentAt: DateTime.makeUnsafe("2026-08-30T12:00:00Z"),
          payload: AttemptChannel.Interrupted.make(),
        }),
      );

      for (const version of [3, 4, 5] as const) {
        assert.strictEqual(
          (yield* Effect.flip(
            Schema.decodeUnknownEffect(AttemptChannel.Envelope)(
              { ...outbound, version },
              { onExcessProperty: "error" },
            ),
          ))._tag,
          "SchemaError",
        );
      }
    }),
  );

  it.effect(
    "reads older rate limits without a login and round-trips login and reset dates through JSON",
    () =>
      Effect.gen(function* () {
        const session = ParentSession.make({
          id: AgentSessionId.make("parent-1"),
          agent: agent.name,
          brain: BrainSpec.make({
            harness: Harness.make("pi"),
            model: parentModel,
            effort: "high",
          }),
        });
        const envelope = AttemptChannel.OutboundEnvelope.make({
          version: AttemptChannel.PROTOCOL_VERSION,
          attemptId: spec.attemptId,
          sequence: AttemptChannel.Sequence.make(1),
          sentAt: DateTime.makeUnsafe("2026-08-30T12:00:00Z"),
          payload: AttemptChannel.SessionEvent.make({
            event: PoolRateLimitsUpdated.make({
              session,
              pool: "chatgptPlan",
              login: Option.some(PoolLogin.make("operator@example.com")),
              rateLimits: RateLimitsSnapshot.make({
                limitId: Option.some("codex"),
                limitName: Option.some("ChatGPT"),
                primary: Option.some(
                  RateLimitWindow.make({
                    usedPercent: 24,
                    windowDurationMinutes: Option.some(300),
                    resetsAt: Option.some(DateTime.makeUnsafe("2026-09-07T02:25:59Z")),
                  }),
                ),
                secondary: Option.some(
                  RateLimitWindow.make({
                    usedPercent: 0,
                    windowDurationMinutes: Option.none(),
                    resetsAt: Option.none(),
                  }),
                ),
              }),
            }),
          }),
        });

        const encoded = yield* Schema.encodeEffect(EnvelopeJson)(envelope);
        const decoded = yield* Schema.decodeEffect(EnvelopeJson)(encoded, {
          onExcessProperty: "error",
        });

        assert.deepStrictEqual(decoded, envelope);
        assert(envelope.payload._tag === "SessionEvent");
        assert(envelope.payload.event._tag === "PoolRateLimitsUpdated");
        const { login: _, ...legacy } = yield* Schema.encodeEffect(PoolRateLimitsUpdated)(
          envelope.payload.event,
        );
        assert(Option.isNone((yield* Schema.decodeEffect(PoolRateLimitsUpdated)(legacy)).login));
        assert.throws(() => PoolLogin.make(""));
      }),
  );

  it.effect("rejects credentials smuggled into a RunSpec", () =>
    Effect.gen(function* () {
      const raw = yield* Schema.encodeEffect(AttemptChannel.RunSpec)(spec);

      assert.strictEqual(
        (yield* Effect.flip(
          Schema.decodeUnknownEffect(AttemptChannel.RunSpec)(
            { ...raw, githubToken: "must-never-cross-the-channel" },
            { onExcessProperty: "error" },
          ),
        ))._tag,
        "SchemaError",
      );
    }),
  );

  it.effect("reads older launch records and round-trips saved harness session metadata", () =>
    Effect.gen(function* () {
      const session = ParentSession.make({
        id: AgentSessionId.make("parent"),
        agent: agent.name,
        brain: agent.brain,
      });
      const legacy = yield* Schema.encodeEffect(SessionStarted)(SessionStarted.make({ session }));
      assert(Option.isNone((yield* Schema.decodeEffect(SessionStarted)(legacy)).harnessSession));
      assert(Option.isNone((yield* Schema.decodeEffect(SessionStarted)(legacy)).prompt));
      const decodedValue2 = yield* Schema.encodeEffect(AttemptChannel.RunSpec)(spec);
      const storedSpec = yield* Schema.decodeUnknownEffect(AttemptChannel.RunSpec)(
        Object.fromEntries(
          Object.entries(decodedValue2).filter(
            ([key]) => !["preparedAt", "botLogin", "parent", "outcomeLabels"].includes(key),
          ),
        ),
      );
      assert(Option.isNone(storedSpec.preparedAt));
      assert(Option.isNone(storedSpec.botLogin));
      // An Attempt stored before the event-driven coordinator reattaches to its Pi parent.
      assert.strictEqual(storedSpec.parent, "pi");
      assert.deepStrictEqual(storedSpec.outcomeLabels, []);
      const started = SessionStarted.make({
        session,
        prompt: Option.some("Exact task\n\n  Preserve whitespace.\n"),
        harnessSession: Option.some(
          HarnessSession.make({
            id: HarnessSessionId.make("native-1"),
            cwd: "/worker/repo",
            home: Option.some("/worker/codex/native-1"),
          }),
        ),
      });
      const encoded = yield* Schema.encodeEffect(SessionStarted)(started);
      const decodedValue1 = yield* Schema.decodeEffect(SessionStarted)(encoded);
      assert.deepStrictEqual(decodedValue1, started);
      // A record from before the home was saved.
      const withoutHome = yield* Schema.decodeEffect(SessionStarted)({
        ...encoded,
        harnessSession: { id: "native-1", cwd: "/worker/repo" },
      });
      assert(Option.isSome(withoutHome.harnessSession));
      assert(Option.isNone(withoutHome.harnessSession.value.home));
      assert.throws(() => HarnessSessionId.make(""));
      assert.throws(() => HarnessSession.make({ id: HarnessSessionId.make("native-1"), cwd: "" }));
      assert.throws(() =>
        HarnessSession.make({
          id: HarnessSessionId.make("native-1"),
          cwd: "/worker/repo",
          home: Option.some(""),
        }),
      );
    }),
  );

  it.effect("preserves launch billing while reading sessions recorded before pools", () =>
    Effect.gen(function* () {
      const parent = ParentSession.make({
        id: AgentSessionId.make("parent"),
        agent: agent.name,
        brain: BrainSpec.make({
          harness: Harness.make("pi"),
          model: ModelId.make("openai-codex/gpt-5"),
          effort: "high",
        }),
      });
      const child = ChildSession.make({
        id: AgentSessionId.make("child"),
        parentId: parent.id,
        agent: agent.name,
        brain: agent.brain,
      });
      for (const [session, expected] of [
        [parent, "chatgptPlan"],
        [child, "claudePlan"],
        [ChildSession.make({ ...child, gatewayCredential: Option.some("api-key") }), "apiKeys"],
        [
          ChildSession.make({
            ...child,
            brain: BrainSpec.make({ ...child.brain, harness: Harness.make("codex") }),
          }),
          "chatgptPlan",
        ],
      ] as const) {
        const encoded = yield* Schema.encodeEffect(AgentSession)(session);
        assert.isFalse("pool" in encoded);
        assert.isFalse("endpoint" in encoded);
        const legacy = yield* Schema.decodeEffect(AgentSession)(encoded);
        assert.isTrue(Option.isNone(legacy.pool));
        assert.strictEqual(sessionPool(legacy), expected);
      }
      for (const session of [
        ParentSession.make({
          ...parent,
          pool: Option.some("apiKeys"),
          endpoint: Option.some(EndpointName.make("ollama")),
        }),
        ChildSession.make({
          ...child,
          brain: BrainSpec.make({ ...child.brain, harness: Harness.make("new-harness") }),
          pool: Option.some("apiKeys"),
          endpoint: Option.some(EndpointName.make("local")),
        }),
      ]) {
        const encoded = yield* Schema.encodeEffect(AgentSession)(session);
        assert.strictEqual(encoded.pool, "apiKeys");
        const stored = yield* Schema.decodeEffect(AgentSession)(encoded);
        assert.deepStrictEqual(stored, session);
        assert.strictEqual(sessionPool(stored), "apiKeys");
      }
      const invalid = yield* Effect.flip(
        Schema.decodeUnknownEffect(ParentSession)({
          _tag: "ParentSession",
          id: "parent",
          agent: "developer",
          brain: { harness: "pi", model: "ollama/qwen", effort: "high" },
          pool: "invalid",
        }),
      );
      assert.strictEqual(invalid._tag, "SchemaError");
      assert.throws(() => EndpointName.make(""));
    }),
  );

  describe("outbound protocol reducer", () => {
    const outbound = (
      sequence: number,
      payload: AttemptChannel.OutboundPayload,
      attemptId = spec.attemptId,
    ) =>
      AttemptChannel.OutboundEnvelope.make({
        version: AttemptChannel.PROTOCOL_VERSION,
        attemptId,
        sequence: AttemptChannel.Sequence.make(sequence),
        sentAt: DateTime.makeUnsafe("2026-08-30T12:00:00Z"),
        payload,
      });
    const started = AttemptChannel.Started.make({ parentModel: Option.some(parentModel) });
    const sessionEvent = AttemptChannel.SessionEvent.make({
      event: SessionStarted.make({
        session: ParentSession.make({
          id: AgentSessionId.make("parent-1"),
          agent: agent.name,
          brain: BrainSpec.make({
            harness: Harness.make("pi"),
            model: parentModel,
            effort: "high",
          }),
        }),
      }),
    });
    const interruptedTerminal = AttemptChannel.Interrupted.make();

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
      assert.match(outcome.failure.message, /another attempt/u);
    });

    it("rejects a non-contiguous sequence", () => {
      const outcome = admitAll([outbound(1, started), outbound(3, sessionEvent)]);
      assert(Result.isFailure(outcome));
      assert.match(outcome.failure.message, /non-contiguous/u);
    });

    it("rejects a first frame that is not Started", () => {
      const outcome = admitAll([outbound(1, sessionEvent)]);
      assert(Result.isFailure(outcome));
      assert.match(outcome.failure.message, /start with a Started or Failed/u);
    });

    it("admits a launch failure as the first and terminal frame", () => {
      const outcome = admitAll([
        outbound(
          1,
          AttemptChannel.Failed.make({
            failure: AgentFailure.make({ message: "Unknown model" }),
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
      assert.match(outcome.failure.message, /after the terminal envelope/u);
    });
  });
});
