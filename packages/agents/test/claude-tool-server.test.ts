// The Claude SDK's input stream and tool server calls require Promise callbacks.
// @effect-diagnostics asyncFunction:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalJson:off
import { assert, describe, it } from "@effect/vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { AsyncInput, ClaudeSdk, claudeSdkLive } from "../src/harness/claude/sdk.ts";
import { callHostTool, hostToolNames, hostToolSet } from "../src/harness/tools.ts";

const ReadNote = Tool.make("read_note", {
  description: "Reads a note.",
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  failure: Schema.Struct({ missing: Schema.String }),
});
const notes = Toolkit.make(ReadNote);
const handlers = notes.toLayer({
  read_note: ({ name }) =>
    name === "greeting" ? Effect.succeed("hello") : Effect.fail({ missing: name }),
});

/** A JSON-RPC response that the stand-in recorded. */
const McpResponse = Schema.Struct({ id: Schema.Finite, result: Schema.Json });

/** The MCP result of a tool call. */
const CallResult = Schema.Struct({
  content: Schema.Tuple([Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })]),
  isError: Schema.Boolean,
});

/**
 * A Claude Code stand-in that answers the SDK's `initialize`, sends the MCP requests in `requests`
 * to the server `usine` over the control channel, writes each response to `responses`, and then
 * reports a turn result.
 */
const scriptedClaude = (responses: string, requests: ReadonlyArray<unknown>) => `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const requests = ${JSON.stringify(requests)};
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
let received = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
      response: { commands: [], agents: [], models: [], account: {}, output_style: 'default', available_output_styles: ['default'] } } });
    if (message.request.subtype === 'initialize')
      requests.forEach((request, n) => send({ type: 'control_request', request_id: 'mcp-' + n,
        request: { subtype: 'mcp_message', server_name: 'usine', message: { jsonrpc: '2.0', id: n + 1, ...request } } }));
  } else if (message.type === 'control_response') {
    fs.appendFileSync(${JSON.stringify(responses)}, JSON.stringify(message.response.response.mcp_response) + '\\n');
    if (++received === requests.length) send({ type: 'result', subtype: 'success', session_id: 'tool-server' });
  }
});
`;

describe("Claude Code tool server", () => {
  it.live("lists usine tools to load up front and returns each call's error state and text", () =>
    Effect.gen(function* () {
      const cwd = mkdtempSync(join(tmpdir(), "usine-claude-tools-"));
      const responses = join(cwd, "responses");
      const executable = join(cwd, "claude");
      writeFileSync(
        executable,
        scriptedClaude(responses, [
          { method: "tools/list", params: {} },
          { method: "tools/call", params: { name: "read_note", arguments: { name: "greeting" } } },
          { method: "tools/call", params: { name: "read_note", arguments: { name: "draft" } } },
          { method: "tools/call", params: { name: "read_note", arguments: { title: "greeting" } } },
        ]),
      );
      chmodSync(executable, 0o755);
      const bound = yield* hostToolSet(notes).pipe(Effect.provide(handlers));
      const names = yield* hostToolNames(bound, { maxLength: 64, reserved: new Set() });
      const call = callHostTool(bound, names);
      const sdk = yield* ClaudeSdk.pipe(Effect.provide(claudeSdkLive));
      const context = yield* Effect.context<never>();
      const run = Effect.runPromiseWith(context);
      // Stays open until the turn result arrives, as a session's input does.
      const input = new AsyncInput();
      const query = sdk.open(
        input,
        { cwd, pathToClaudeCodeExecutable: executable, settingSources: [], persistSession: false },
        Option.some({
          name: "usine",
          tools: bound.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          })),
          call: (name, toolInput) => run(call(name, toolInput, Option.none())),
        }),
      );
      yield* Effect.promise(async () => {
        for await (const message of query)
          if (Schema.is(Schema.Struct({ type: Schema.Literal("result") }))(message)) break;
      }).pipe(Effect.ensuring(Effect.sync(() => query.close())));

      // Calls run concurrently, so responses arrive in any order; each carries its request's ID.
      const decode = Schema.decodeEffect(Schema.fromJsonString(McpResponse));
      const lines = yield* Effect.forEach(
        readFileSync(responses, "utf8").trim().split("\n"),
        (line) => decode(line),
      );
      const [list, greeting, draft, invalid] = lines
        .sort((a, b) => a.id - b.id)
        .map(({ result }) => result);
      assert.deepStrictEqual<unknown>(list, {
        tools: [
          {
            name: "read_note",
            description: "Reads a note.",
            inputSchema: bound.tools[0]?.parameters,
            _meta: { "anthropic/alwaysLoad": true },
          },
        ],
      });
      assert.deepStrictEqual(greeting, {
        content: [{ type: "text", text: "hello" }],
        isError: false,
      });
      assert.deepStrictEqual(draft, {
        content: [{ type: "text", text: '{"missing":"draft"}' }],
        isError: true,
      });
      const rejected = yield* Schema.decodeUnknownEffect(CallResult)(invalid);
      assert.isTrue(rejected.isError);
      assert.include(rejected.content[0].text, "Invalid parameters for tool 'read_note'");
    }),
  );
});
