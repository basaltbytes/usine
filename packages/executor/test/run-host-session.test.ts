import { assert, describe, it } from "@effect/vitest";
import { Agent, Attempt, AttemptChannel } from "@usine/core";
import { DateTime, Result, Schema } from "effect";
import { invalidFrameDiagnostic } from "../src/invalid-frame.ts";

const validStartedLine = () =>
  Schema.encodeSync(AttemptChannel.OutboundEnvelopeFromJson)(
    new AttemptChannel.OutboundEnvelope({
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId: Attempt.AttemptId.make("run/step/1"),
      sequence: AttemptChannel.Sequence.make(1),
      sentAt: DateTime.makeUnsafe("2026-09-01T12:00:00Z"),
      payload: new AttemptChannel.Started({
        parentModel: Agent.ModelId.make("openai-codex/gpt-5.4-mini"),
      }),
    }),
  );

const decodeFailure = (line: string) => {
  const decoded = Schema.decodeUnknownResult(AttemptChannel.OutboundEnvelopeFromJson)(line, {
    onExcessProperty: "error",
  });
  assert(Result.isFailure(decoded));
  return decoded.failure;
};

describe("run-host frame diagnostics", () => {
  it("distinguishes log pollution from other malformed JSON without retaining content", () => {
    const logLine = "[19:31:20.123] INFO: child started with credential gh-secret";
    const diagnostic = invalidFrameDiagnostic(logLine, new Error("invalid JSON"));

    assert.strictEqual(diagnostic.source, "effect-log");
    assert.strictEqual(diagnostic.byteLength, new TextEncoder().encode(logLine).byteLength);
    assert(!JSON.stringify(diagnostic).includes("gh-secret"));
  });

  it("reports schema paths while redacting unexpected keys and values", () => {
    const raw = JSON.parse(validStartedLine());
    raw.payload["credential-gh-secret"] = "credential-value-gh-secret";
    const line = JSON.stringify(raw);
    const diagnostic = invalidFrameDiagnostic(line, decodeFailure(line));
    const rendered = JSON.stringify(diagnostic);

    assert.strictEqual(diagnostic.source, "json");
    assert.strictEqual(diagnostic.version, AttemptChannel.PROTOCOL_VERSION);
    assert.strictEqual(diagnostic.payloadTag, "Started");
    assert(diagnostic.issues.some(({ path }) => path.includes("<unexpected>")));
    assert(!rendered.includes("credential-gh-secret"));
    assert(!rendered.includes("credential-value-gh-secret"));
  });

  it("does not expose an unrecognized payload tag", () => {
    const raw = JSON.parse(validStartedLine());
    raw.payload._tag = "credential-gh-secret";
    const line = JSON.stringify(raw);
    const diagnostic = invalidFrameDiagnostic(line, decodeFailure(line));

    assert.strictEqual(diagnostic.source, "json");
    assert.strictEqual(diagnostic.payloadTag, undefined);
    assert(diagnostic.issues.length > 0);
    assert(!JSON.stringify(diagnostic).includes("credential-gh-secret"));
  });
});
