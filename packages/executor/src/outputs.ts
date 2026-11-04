import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import type { RunSpec } from "@usine/core/attempt/channel";
import { CommitSha } from "@usine/core/repository";
import {
  MAX_STEP_OUTPUT_BYTES,
  MAX_STEP_OUTPUTS,
  StepOutput,
  StepOutputName,
  StepOutputSha256,
  StepOutputType,
} from "@usine/core/step/output";
import { type Crypto, Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { CommandOutputLimitExceeded } from "./child-command.ts";
import { ExecutorOperationError } from "./executor.ts";

type OutputCommand<E> = (
  command: string,
  args: ReadonlyArray<string>,
  maxOutputBytes?: number,
) => Effect.Effect<string, E>;

// Each content body can be 8 MiB; allow bounded envelope and collection metadata.
const MAX_COLLECTION_BYTES = MAX_STEP_OUTPUTS * (MAX_STEP_OUTPUT_BYTES + 4096);

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
const root = '.usine/outputs/';
const reject = (file, reason) => { process.stdout.write(JSON.stringify({ error: { file, reason } })); };
const collect = () => {
  let files;
  try { files = fs.readdirSync(root).sort(); }
  catch (error) {
    if (error.code === 'ENOTDIR') return reject(root, 'expected a directory');
    if (error.code !== 'ENOENT') throw error;
    files = [];
  }
  if (files.length > ${MAX_STEP_OUTPUTS}) return reject(root + files[${MAX_STEP_OUTPUTS}], 'at most ${MAX_STEP_OUTPUTS} outputs are allowed');
  const outputs = [];
  for (const file of files) {
    const location = root + file;
    if (!file.endsWith('.json')) return reject(location, 'expected a .json file');
    let envelope;
    try {
      if (!fs.lstatSync(location).isFile()) return reject(location, 'expected a regular file');
      if (fs.statSync(location).size > ${MAX_STEP_OUTPUT_BYTES}) return reject(location, 'exceeds ${MAX_STEP_OUTPUT_BYTES} bytes (8 MiB)');
      envelope = JSON.parse(fs.readFileSync(location, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) return reject(location, 'invalid JSON');
      if (['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'ELOOP'].includes(error.code)) return reject(location, 'expected a readable regular file');
      throw error;
    }
    if (envelope?.content === undefined) return reject(location, 'content is required');
    try {
      const content = JSON.stringify(envelope.content);
      if (Buffer.byteLength(content, 'utf8') > ${MAX_STEP_OUTPUT_BYTES}) return reject(location, 'content exceeds ${MAX_STEP_OUTPUT_BYTES} bytes (8 MiB)');
      outputs.push(JSON.stringify({ file, envelope }));
    } catch {
      return reject(location, 'content cannot be serialized as JSON');
    }
  }
  process.stdout.write('{"outputs":[' + outputs.join(',') + ']}');
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
export const readOutputs = Effect.fn("Executor.readOutputs")(
  function* <E>(
    spec: Pick<RunSpec, "attemptId" | "baseCommit">,
    run: OutputCommand<E>,
    crypto: Crypto.Crypto,
  ) {
    yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, baseCommit: spec.baseCommit });
    const response = yield* run("node", ["-e", readScript], MAX_COLLECTION_BYTES).pipe(
      Effect.mapError((cause) =>
        Schema.is(ExecutorOperationError)(cause) &&
        Schema.is(CommandOutputLimitExceeded)(cause.cause)
          ? AgentFailure.make({
              message: `.usine/outputs/: collection exceeds ${MAX_COLLECTION_BYTES} bytes`,
            })
          : InfraFailure.make({ message: "Can't read step outputs", cause }),
      ),
    );
    if (new TextEncoder().encode(response).byteLength > MAX_COLLECTION_BYTES)
      return yield* AgentFailure.make({
        message: `.usine/outputs/: collection exceeds ${MAX_COLLECTION_BYTES} bytes`,
      });
    const collected = yield* Schema.decodeEffect(Schema.fromJsonString(Collection))(response).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(InfraFailure.make({ message: "Can't decode the output collection", cause })),
      ),
    );
    if ("error" in collected)
      return yield* AgentFailure.make({
        message: `${collected.error.file}: ${collected.error.reason}`,
      });
    if (collected.outputs.length > MAX_STEP_OUTPUTS)
      return yield* AgentFailure.make({
        message: `.usine/outputs/${collected.outputs[MAX_STEP_OUTPUTS]?.file}: at most ${MAX_STEP_OUTPUTS} outputs are allowed`,
      });
    const outputs = yield* Effect.forEach(collected.outputs, (entry) =>
      Effect.gen(function* () {
        const file = `.usine/outputs/${entry.file}`;
        if (!entry.file.endsWith(".json"))
          return yield* AgentFailure.make({ message: `${file}: expected a .json file` });
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
              message: `${file}: invalid envelope; expected a non-empty type of at most 128 characters, optional full commit, and JSON content`,
            }),
          ),
        );
        if (Option.isSome(envelope.commit) && envelope.commit.value !== spec.baseCommit)
          return yield* AgentFailure.make({
            message: `${file}: commit must equal ${spec.baseCommit}`,
          });
        const content = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
          envelope.content,
        ).pipe(
          Effect.mapError(() =>
            AgentFailure.make({ message: `${file}: content cannot be serialized as JSON` }),
          ),
        );
        const bytes = new TextEncoder().encode(content);
        if (bytes.byteLength > MAX_STEP_OUTPUT_BYTES)
          return yield* AgentFailure.make({
            message: `${file}: content exceeds ${MAX_STEP_OUTPUT_BYTES} bytes (8 MiB)`,
          });
        const digest = yield* crypto
          .digest("SHA-256", bytes)
          .pipe(
            Effect.mapError((cause) =>
              InfraFailure.make({ message: "Can't hash step output content", cause }),
            ),
          );
        return StepOutput.make({
          name,
          ...envelope,
          size: bytes.byteLength,
          sha256: StepOutputSha256.make(Hex.encode(digest)),
        });
      }),
    );
    yield* Effect.logInfo("Collected step outputs", {
      attemptId: spec.attemptId,
      outputs: outputs.length,
      bytes: outputs.reduce((total, output) => total + output.size, 0),
    });
    return outputs;
  },
  (effect) =>
    effect.pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Step output collection failed", { message: error.message }),
      ),
    ),
);
