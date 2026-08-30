import { assert, describe, it } from "@effect/vitest";
import { DateTime, Schema } from "effect";
import { AttemptChannel, Attempt, Repository, StepResult } from "../src/index.ts";

const spec = new AttemptChannel.RunSpec({
  attemptId: Attempt.AttemptId.make("attempt-1"),
  repository: Repository.Name.make("basaltbytes/usine"),
  revision: Repository.Revision.make("main"),
  baseCommit: Repository.CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
  task: AttemptChannel.Task.make("Implement the issue"),
});

describe("attempt channel v1", () => {
  it("round-trips a final envelope through its framed JSON schema", () => {
    const envelope = new AttemptChannel.OutboundEnvelope({
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId: spec.attemptId,
      sequence: AttemptChannel.Sequence.make(1),
      sentAt: DateTime.makeUnsafe("2026-08-30T12:00:00Z"),
      payload: new AttemptChannel.Final({
        result: new StepResult.StepResult({
          message: "Done",
          facts: [
            new StepResult.Commit({
              sha: Repository.CommitSha.make("fedcba9876543210fedcba9876543210fedcba98"),
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
});
