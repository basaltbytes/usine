import { assert } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { claudeChildLayer } from "../../src/harness/claude/claude.ts";
import { claudeSdkLive } from "../../src/harness/claude/sdk.ts";
import { ChildRequest, HostLoginLock, type ChildBackend } from "../../src/runtime.ts";
import { childPidFile } from "../../src/child-host/child-host.ts";
import type { Transcript } from "./transcript.ts";

/** Replays one recorded CLI turn through the real SDK and worker process owner. */
export const ownedClaudeReplay = Effect.fn("Replay.ownedClaude")(function* (
  request: ChildRequest,
  recording: Transcript,
  fault: "transport-loss" | "early-exit",
) {
  const fs = yield* FileSystem.FileSystem;
  const messages = recording.entries.flatMap((entry) =>
    entry.type === "emit_inbound" && entry.port === "claude:2/output" ? [entry.payload] : [],
  );
  if (fault === "transport-loss") assert(messages.length > 2);
  const payload = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(messages);
  const model = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(
    request.session.brain.model,
  );
  const source =
    fault === "early-exit"
      ? "process.stderr.write('replayed early exit'); process.exitCode = 7;"
      : `
const fs = require('node:fs');
const readline = require('node:readline');
const messages = ${payload};
fs.appendFileSync('launches', String(process.pid) + '\\n');
fs.appendFileSync('launch-arguments', JSON.stringify(process.argv.slice(2)) + '\\n');
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
let waiting = false;
const timer = setInterval(() => {
  if (waiting && fs.existsSync('release')) { waiting = false; for (const message of messages.slice(2)) send(message); }
}, 10);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {
    commands: [], agents: [], models: [{ value: ${model}, displayName: 'Replay', description: 'Recorded model' }], account: { apiKeySource: 'none' }, output_style: 'default', available_output_styles: ['default'],
  } } });
  else if (message.type === 'user') { fs.appendFileSync('user-messages', JSON.stringify(message) + '\\n'); for (const message of messages.slice(0, 2)) send(message); waiting = true; }
}).on('close', () => { clearInterval(timer); });
`;
  yield* fs.writeFileString(`${request.cwd}/claude`, `#!/usr/bin/env node\n${source}`);
  yield* fs.chmod(`${request.cwd}/claude`, 0o755);
  const environment = {
    ...request.environment,
    PATH: `${request.cwd}:${request.environment.PATH}`,
  };
  const updated = ChildRequest.make({ ...request, environment });
  const backend: Layer.Layer<ChildBackend> = claudeChildLayer.pipe(
    Layer.provide(claudeSdkLive),
    Layer.provide(Layer.succeed(HostLoginLock)({ withLock: () => (effect) => effect })),
    Layer.provide(NodeServices.layer),
  );
  const save = Effect.gen(function* () {
    if (fault === "transport-loss") {
      const launches = yield* fs.readFileString(`${request.cwd}/launches`);
      assert.lengthOf(launches.trim().split("\n"), 1, "transport loss retains one Claude process");
    }
    const pidFile = childPidFile(request.cwd, request.session.id);
    const retained = yield* fs.exists(pidFile);
    assert.isFalse(retained);
  });
  return { request: updated, backend, save };
});
