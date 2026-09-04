import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  PoolRateLimitsUpdated,
  RateLimitsSnapshot,
  RateLimitWindow,
  TextOutput,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentName, AttemptId } from "@usine/core/ids";
import { Option } from "effect";
import {
  TranscriptCursor,
  TranscriptEventView,
  TranscriptPageCursor,
} from "@usine/orchestrator/operator/model";
import { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import {
  mergeTranscript,
  poolMeters,
  replaceEarlierCursor,
  RUN_DETAIL_CACHE_STRUCTURAL_SHARING,
  Transcript,
} from "../src/run-transcript.tsx";

const attemptId = AttemptId.make("attempt-31");
const brain = new BrainSpec({
  harness: "codex",
  model: ModelId.make("gpt-5"),
  effort: "high",
});

const event = (
  sequence: number,
  text: string,
  scope: "parent" | "child" | "channel" = "parent",
  session = `${scope}-session`,
) => {
  const agent = AgentName.make(scope === "child" ? `agent-${session}` : "developer");
  const sessionView =
    scope === "child"
      ? new ChildSession({
          id: AgentSessionId.make(session),
          parentId: AgentSessionId.make("parent-session"),
          agent,
          brain,
        })
      : new ParentSession({
          id: AgentSessionId.make(session),
          agent,
          brain,
        });
  return new TranscriptEventView({
    sequence: TranscriptCursor.make(sequence),
    attemptId,
    receivedAt: "2026-09-01T12:00:00.000Z",
    direction: "outbound",
    payload:
      scope === "channel"
        ? new AttemptChannel.Started({
            parentModel: ModelId.make("gpt-5"),
          })
        : new AttemptChannel.SessionEvent({
            event: new TextOutput({ session: sessionView, text }),
          }),
  });
};

const rateLimits = (sequence: number, usedPercent: number) =>
  new TranscriptEventView({
    sequence: TranscriptCursor.make(sequence),
    attemptId,
    receivedAt: "2026-09-01T12:00:00.000Z",
    direction: "outbound",
    payload: new AttemptChannel.SessionEvent({
      event: new PoolRateLimitsUpdated({
        session: new ParentSession({
          id: AgentSessionId.make("parent-session"),
          agent: AgentName.make("developer"),
          brain,
        }),
        pool: "chatgptPlan",
        rateLimits: new RateLimitsSnapshot({
          limitId: Option.none(),
          limitName: Option.none(),
          primary: Option.some(
            new RateLimitWindow({
              usedPercent,
              windowDurationMinutes: Option.none(),
              resetsAt: Option.none(),
            }),
          ),
          secondary: Option.none(),
        }),
      }),
    }),
  });

describe("run transcript", () => {
  it("keeps rate-limit updates out of the feed and folds them into one meter per pool", () => {
    const events = [event(1, "Parent update"), rateLimits(2, 25), rateLimits(3, 31)];
    const markup = renderToStaticMarkup(<Transcript events={events} />);
    assert.ok(!markup.includes("rate limits"));
    assert.deepStrictEqual(poolMeters(events), [
      { pool: "chatgptPlan", primaryUsedPercent: 31, secondaryUsedPercent: null },
    ]);
  });

  it("renders parent activity inline and groups each child session one level deep", () => {
    const markup = renderToStaticMarkup(
      <Transcript
        events={[
          event(1, "Parent update"),
          event(2, "Child tool started", "child"),
          event(3, "Child tool finished", "child"),
          event(4, "Channel notice", "channel"),
        ]}
      />,
    );

    assert.strictEqual((markup.match(/data-slot="collapsible"/g) ?? []).length, 1);
    assert.match(markup, /agent-child-session activity.*2 events/);
    assert.ok(markup.indexOf("Parent update") < markup.indexOf("activity"));
    assert.ok(markup.indexOf("activity") < markup.indexOf("Attempt started"));
  });

  it("keeps concurrent child sessions distinct, each anchored at its own first event", () => {
    const markup = renderToStaticMarkup(
      <Transcript
        events={[
          event(1, "First child says hello", "child", "child-a"),
          event(2, "Parent update"),
          event(3, "Second child says hello", "child", "child-b"),
        ]}
      />,
    );

    assert.strictEqual((markup.match(/data-slot="collapsible"/g) ?? []).length, 2);
    assert.ok(markup.indexOf("agent-child-a activity") < markup.indexOf("Parent update"));
    assert.ok(markup.indexOf("Parent update") < markup.indexOf("agent-child-b activity"));
  });

  it("merges transcript tails by sequence without replaying an existing event", () => {
    const first = event(1, "First");
    const second = event(2, "Second");
    const merged = mergeTranscript([second, first], [second, event(3, "Third")]);

    assert.deepStrictEqual(
      merged.map(({ sequence, payload }) => [
        sequence,
        payload._tag === "SessionEvent" && payload.event._tag === "TextOutput"
          ? payload.event.text
          : payload._tag,
      ]),
      [
        [1, "First"],
        [2, "Second"],
        [3, "Third"],
      ],
    );
  });

  it("replaces only the cursor for the Attempt whose earlier page was loaded", () => {
    const firstAttempt = AttemptId.make("attempt-1");
    const secondAttempt = AttemptId.make("attempt-2");
    const cursors = [
      new TranscriptPageCursor({
        attemptId: firstAttempt,
        before: TranscriptCursor.make(100),
      }),
      new TranscriptPageCursor({
        attemptId: secondAttempt,
        before: TranscriptCursor.make(200),
      }),
    ];
    const replaced = replaceEarlierCursor(cursors, secondAttempt, [
      new TranscriptPageCursor({
        attemptId: secondAttempt,
        before: TranscriptCursor.make(50),
      }),
    ]);

    assert.deepStrictEqual(
      replaced.map(({ attemptId, before }) => [attemptId, before]),
      [
        [secondAttempt, 50],
        [firstAttempt, 100],
      ],
    );
  });

  it("advances manual earlier-page cursors through the TanStack cache until exhaustion", () => {
    const queryClient = new QueryClient();
    const key = ["run", "run-31"] as const;
    queryClient.setQueryDefaults(["run"], {
      structuralSharing: RUN_DETAIL_CACHE_STRUCTURAL_SHARING,
    });
    queryClient.setQueryData(key, {
      earlierTranscript: [
        new TranscriptPageCursor({
          attemptId,
          before: TranscriptCursor.make(300),
        }),
      ],
    });

    for (const before of [200, 100] as const) {
      queryClient.setQueryData<{ earlierTranscript: ReadonlyArray<TranscriptPageCursor> }>(
        key,
        (previous) => ({
          earlierTranscript: replaceEarlierCursor(previous?.earlierTranscript ?? [], attemptId, [
            new TranscriptPageCursor({
              attemptId,
              before: TranscriptCursor.make(before),
            }),
          ]),
        }),
      );
      const current = queryClient.getQueryData<{
        earlierTranscript: ReadonlyArray<TranscriptPageCursor>;
      }>(key)?.earlierTranscript[0]?.before;
      assert(current !== undefined);
      assert.strictEqual(current, TranscriptCursor.make(before));
    }

    queryClient.setQueryData<{ earlierTranscript: ReadonlyArray<TranscriptPageCursor> }>(
      key,
      (previous) => ({
        earlierTranscript: replaceEarlierCursor(previous?.earlierTranscript ?? [], attemptId, []),
      }),
    );
    assert.deepStrictEqual(
      queryClient.getQueryData<{ earlierTranscript: ReadonlyArray<TranscriptPageCursor> }>(key)
        ?.earlierTranscript,
      [],
    );
  });
});
