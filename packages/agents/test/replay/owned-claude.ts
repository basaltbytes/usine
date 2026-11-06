// SDK replay controls require an async iterator.
// @effect-diagnostics asyncFunction:off
import { assert } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { claudeChildLayer } from "../../src/harness/claude/claude.ts";
import { ClaudeSdk, claudeSdkLive } from "../../src/harness/claude/sdk.ts";
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
const sessionState = state => ({ type: 'system', subtype: 'session_state_changed', state,
  sdk_host_only: true, session_id: messages[0].session_id, uuid: require('node:crypto').randomUUID() });
const mirror = { type: 'transcript_mirror', filePath: '/replay/session.jsonl', entries: [] };
const sendBatch = batch => process.stdout.write(batch.map(message => JSON.stringify(message) + '\\n').join(''));
let waiting = false;
let hookPending = false;
const timer = setInterval(() => {
  if (fs.existsSync('request-sdk-tail') && !fs.existsSync('sdk-tail-sent')) {
    sendBatch([sessionState('idle'), mirror]);
    fs.writeFileSync('sdk-tail-sent', 'ready\\n');
  }
    if (waiting && !hookPending && !fs.existsSync('hook-sent') && fs.existsSync('request-hook')) {
      hookPending = true;
      send({ type: 'control_request', request_id: 'pending-hook', request: {
        subtype: 'hook_callback', callback_id: 'hook_0', tool_use_id: 'pending-tool',
        input: { hook_event_name: 'PreToolUse', session_id: messages[0].session_id, tool_name: 'Bash', tool_input: { command: 'true' } },
      } });
      fs.writeFileSync('hook-sent', 'ready');
    }
  if (waiting && !hookPending && fs.existsSync('release')) { waiting = false; sendBatch([...messages.slice(2), sessionState('idle'), mirror]); }
}, 10);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {
    commands: [], agents: [], models: [{ value: ${model}, displayName: 'Replay', description: 'Recorded model' }], account: { apiKeySource: 'none' }, output_style: 'default', available_output_styles: ['default'],
  } } });
  else if (message.type === 'control_response') {
    if (message.response.request_id === 'pending-hook' && message.response.subtype === 'success') {
      hookPending = false;
      fs.appendFileSync('hook-responses', JSON.stringify(message) + '\\n');
    }
  }
  else if (message.type === 'user') {
    fs.appendFileSync('user-messages', JSON.stringify(message) + '\\n');
    if (fs.existsSync('exit-resume') && process.argv.some(arg => arg.startsWith('--resume'))) process.exit(1);
    // One write makes the checkpoint exercise multiple protocol messages in one owner frame.
    sendBatch([sessionState('running'), mirror, ...messages.slice(0, 2)]);
    waiting = true;
  }
}).on('close', () => { clearInterval(timer); });
`;
  yield* fs.writeFileString(`${request.cwd}/claude`, `#!/usr/bin/env node\n${source}`);
  yield* fs.chmod(`${request.cwd}/claude`, 0o755);
  const environment = {
    ...request.environment,
    PATH: `${request.cwd}:${request.environment.PATH}`,
  };
  const updated = ChildRequest.make({ ...request, environment });
  const sdk = yield* ClaudeSdk.pipe(Effect.provide(claudeSdkLive));
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  const replaySdk = Layer.succeed(ClaudeSdk)({
    open: (input, options) => {
      const query = sdk.open(input, options);
      return {
        ...query,
        async *[Symbol.asyncIterator]() {
          for await (const message of query) {
            if (
              Schema.is(Schema.Struct({ type: Schema.Literal("result") }))(message) &&
              (await run(fs.exists(`${request.cwd}/block-result`)))
            ) {
              await run(fs.writeFileString(`${request.cwd}/result-buffered`, "ready"));
              while (await run(fs.exists(`${request.cwd}/block-result`)))
                await run(Effect.sleep("10 millis"));
              return;
            }
            yield message;
          }
        },
      };
    },
  });
  const backend: Layer.Layer<ChildBackend> = claudeChildLayer.pipe(
    Layer.provide(replaySdk),
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
