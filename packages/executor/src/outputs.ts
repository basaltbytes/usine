import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import type { RunSpec } from "@usine/core/attempt/channel";
import { CommitSha } from "@usine/core/repository";
import {
  MAX_STEP_OUTPUT_BYTES,
  MAX_STEP_OUTPUTS,
  StepOutput,
  StepOutputName,
  StepOutputType,
} from "@usine/core/step/output";
import { Effect, Option, Schema } from "effect";

type OutputCommand<E> = (command: string, args: ReadonlyArray<string>) => Effect.Effect<string, E>;

const prepareScript = `
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const exclude = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim();
fs.mkdirSync(path.dirname(exclude), { recursive: true });
const previous = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
if (!previous.split('\\n').includes('/.usine/')) fs.appendFileSync(exclude, '\\n/.usine/\\n');
fs.mkdirSync('.usine/outputs', { recursive: true });
`;

// A whole JSON response preserves embedded newlines and bounds reads before transferring bodies.
const readScript = `
const fs = require('node:fs');
const crypto = require('node:crypto');
const root = '.usine/outputs/';
const reject = (file, reason) => { process.stdout.write(JSON.stringify({ error: { file, reason } })); };
const collect = () => {
  const files = fs.readdirSync(root).sort();
  if (files.length > ${MAX_STEP_OUTPUTS}) return reject(root + files[${MAX_STEP_OUTPUTS}], 'at most ${MAX_STEP_OUTPUTS} outputs are allowed');
  const outputs = [];
  for (const file of files) {
    const location = root + file;
    if (!file.endsWith('.json')) return reject(location, 'expected a .json file');
    if (!fs.lstatSync(location).isFile()) return reject(location, 'expected a regular file');
    if (fs.statSync(location).size > ${MAX_STEP_OUTPUT_BYTES}) return reject(location, 'exceeds ${MAX_STEP_OUTPUT_BYTES} bytes (8 MiB)');
    let envelope;
    try { envelope = JSON.parse(fs.readFileSync(location, 'utf8')); }
    catch { return reject(location, 'invalid JSON'); }
    const content = JSON.stringify(envelope?.content);
    if (content === undefined) return reject(location, 'content is required');
    outputs.push({ file, envelope, size: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') });
  }
  process.stdout.write(JSON.stringify({ outputs }));
};
collect();
`;

const Envelope = Schema.Struct({
  type: StepOutputType,
  commit: Schema.OptionFromOptionalKey(CommitSha),
  content: Schema.Json,
});
const Collection = Schema.Union([
  Schema.Struct({ error: Schema.Struct({ file: Schema.String, reason: Schema.String }) }),
  Schema.Struct({
    outputs: Schema.Array(
      Schema.Struct({
        file: Schema.String,
        envelope: Schema.Unknown,
        size: StepOutput.fields.size,
        sha256: StepOutput.fields.sha256,
      }),
    ),
  }),
]);

/** Creates the output directory and excludes `.usine/` from commits and salvage. */
export const prepareOutputs = Effect.fn("Executor.prepareOutputs")(function* <E>(
  run: OutputCommand<E>,
) {
  yield* run("node", ["-e", prepareScript]);
  yield* Effect.logDebug("Prepared the excluded step output directory");
});

/** Collects output documents through the checkout's command runner. */
export const readOutputs = Effect.fn("Executor.readOutputs")(function* <E>(
  spec: Pick<RunSpec, "attemptId" | "baseCommit">,
  run: OutputCommand<E>,
) {
  yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, baseCommit: spec.baseCommit });
  const collected = yield* run("node", ["-e", readScript]).pipe(
    Effect.mapError((cause) => InfraFailure.make({ message: "Can't read step outputs", cause })),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Collection))),
    Effect.catchTag("SchemaError", (cause) =>
      Effect.fail(InfraFailure.make({ message: "Can't decode the output collection", cause })),
    ),
  );
  if ("error" in collected)
    return yield* AgentFailure.make({
      message: `${collected.error.file}: ${collected.error.reason}`,
    });
  const outputs = yield* Effect.forEach(collected.outputs, (entry) =>
    Effect.gen(function* () {
      const file = `.usine/outputs/${entry.file}`;
      const name = yield* Schema.decodeEffect(StepOutputName)(entry.file.slice(0, -5)).pipe(
        Effect.mapError(() =>
          AgentFailure.make({ message: `${file}: name must be a lowercase file-name slug` }),
        ),
      );
      const envelope = yield* Schema.decodeUnknownEffect(Envelope)(entry.envelope, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(() =>
          AgentFailure.make({
            message: `${file}: invalid envelope; expected a non-empty type, optional full commit, and JSON content`,
          }),
        ),
      );
      if (Option.isSome(envelope.commit) && envelope.commit.value !== spec.baseCommit)
        return yield* AgentFailure.make({
          message: `${file}: commit must equal ${spec.baseCommit}`,
        });
      return StepOutput.make({ name, ...envelope, size: entry.size, sha256: entry.sha256 });
    }),
  );
  yield* Effect.logInfo("Collected step outputs", {
    attemptId: spec.attemptId,
    outputs: outputs.length,
    bytes: outputs.reduce((total, output) => total + output.size, 0),
  });
  return outputs;
});
