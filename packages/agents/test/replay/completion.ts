import { assert } from "@effect/vitest";
import { AgentSessionId, RoleName, RoleSession } from "@usine/core/agent/session";
import { type Crypto, Effect, FileSystem, Option, Result, Schema } from "effect";
import { admitBrain, AdmissionContext } from "../../src/harness/admission.ts";
import type { CredentialRoute, Placement } from "../../src/harness/capability.ts";
import { catalog } from "../../src/harness/catalog.ts";
import { SessionSpec } from "../../src/harness/contract.ts";
import { RolePlacements, RoleSpec } from "../../src/harness/role.ts";
import type { HarnessRuntime } from "../../src/harness/runtime.ts";
import type { ChildRequest, HostLoginLock } from "../../src/runtime.ts";
import { ChildProcessSpawner } from "effect/process";
import { claudeRuntime, type ClaudeSdk } from "../../src/harness/claude/claude.ts";
import { type CodexAppServer, codexRuntime } from "../../src/harness/codex/codex.ts";
import { piRuntime } from "../../src/harness/pi/pi.ts";
import { type FixtureOptions, openFixture, openPiFixture, type Provider } from "./fixture.ts";
import type { Scenario } from "./transcript.ts";

/** The scenarios that run one structured completion instead of a session. */
export const completionScenarios = [
  "structured-result",
  "ephemeral",
] as const satisfies ReadonlyArray<Scenario>;
export type CompletionScenario = (typeof completionScenarios)[number];

/** The value that every completion scenario asks for. */
export const Classification = Schema.Struct({ label: Schema.Literals(["fruit", "vegetable"]) });

const prompts = {
  "structured-result": "Classify the word apple as a fruit or a vegetable.",
  ephemeral: "Classify the word carrot as a fruit or a vegetable.",
} satisfies Record<CompletionScenario, string>;

/** The value that each scenario's recorded model returned. */
export const recordedValues = {
  "structured-result": { label: "fruit" },
  ephemeral: { label: "vegetable" },
} satisfies Record<CompletionScenario, typeof Classification.Type>;

/**
 * A role that returns a structured value and keeps no conversation. It doesn't need the harness's
 * own tools turned off, so it doesn't require `closed-tools`.
 */
const completionRole = RoleSpec.make({
  name: RoleName.make("contract-completion"),
  placement: RolePlacements.make({
    placements: ["orchestrator", "local", "ssh", "container", "sandbox"],
    reason: "The contract completion runs anywhere",
  }),
  credential: Option.none(),
  nativeTools: "all",
  hostTools: false,
  persistence: "ephemeral",
  interventions: false,
  output: "structured",
});

/** Where each harness saves conversations for the checkout of `request`. */
const conversationStore = (provider: Provider, request: ChildRequest): string => {
  const { environment, cwd } = request;
  switch (provider) {
    case "claude":
      return `${environment.CLAUDE_CONFIG_DIR ?? `${environment.HOME}/.claude`}/projects`;
    case "codex":
      return `${environment.CODEX_HOME ?? `${environment.HOME}/.codex`}/sessions`;
    case "pi":
      return `${cwd}/.usine/pi/sessions`;
  }
};

const listing = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(directory))) return [];
    return yield* fs.readDirectory(directory, { recursive: true });
  });

/**
 * Runs the completion of `scenario` through `runtime` with the brain, checkout, and environment of
 * `request`, admitted for the contract completion role at `context`. An `ephemeral` run also checks
 * that the harness saved no conversation.
 */
export const runCompletion = (
  provider: Provider,
  scenario: CompletionScenario,
  runtime: HarnessRuntime,
  request: ChildRequest,
  context: { readonly placement: Placement; readonly credential: CredentialRoute },
) =>
  Effect.gen(function* () {
    const session = RoleSession.make({
      id: AgentSessionId.make("replay-completion"),
      role: completionRole.name,
      agent: request.session.agent,
      brain: request.session.brain,
    });
    const admitted = admitBrain(
      catalog,
      completionRole,
      session.brain,
      AdmissionContext.make(context),
    );
    assert(Result.isSuccess(admitted), "the descriptor admits a structured, ephemeral role");
    const spec = SessionSpec.make({
      session,
      admitted: admitted.success,
      host: request.host,
      worker: request.worker,
      machine: request.machine,
      cwd: request.cwd,
      environment: request.environment,
    });
    const store = conversationStore(provider, request);
    const before = yield* listing(store);
    const completion = yield* runtime
      .complete(spec, prompts[scenario], Classification)
      .pipe(Effect.result);
    if (scenario === "ephemeral") {
      const after = yield* listing(store);
      assert.deepStrictEqual(after, before, "the completion saves no conversation");
      if (Result.isSuccess(completion))
        assert.deepStrictEqual(
          Object.keys(completion.success).sort(),
          ["usage", "value"],
          "the completion returns no session reference",
        );
    }
    return completion;
  });

/**
 * Opens the recorded or recording transport of `provider` for `scenario` and returns the
 * completion run through it, with the fixture's `save`.
 */
export const openCompletionFixture = (
  provider: Provider,
  scenario: CompletionScenario,
  mode: "record" | "replay",
  options: FixtureOptions = {},
) =>
  Effect.gen(function* () {
    if (provider === "pi") {
      const fixture = yield* openPiFixture(scenario, mode, options);
      return {
        save: fixture.save,
        run: piRuntime.pipe(
          Effect.flatMap((runtime) =>
            runCompletion(provider, scenario, runtime, fixture.request, {
              placement: "local",
              credential: "host-login",
            }),
          ),
          Effect.provide(fixture.harness),
          fixture.tape.guard,
        ),
      };
    }
    const fixture = yield* openFixture(provider, scenario, mode, options);
    assert("harness" in fixture, "a completion replays through the runtime layers");
    const runtime: Effect.Effect<
      HarnessRuntime,
      never,
      | ClaudeSdk
      | CodexAppServer
      | HostLoginLock
      | ChildProcessSpawner.ChildProcessSpawner
      | Crypto.Crypto
    > = provider === "claude" ? claudeRuntime : codexRuntime;
    return {
      save: fixture.save,
      run: runtime.pipe(
        Effect.flatMap((runtime) =>
          runCompletion(provider, scenario, runtime, fixture.request, {
            placement: "local",
            credential: "gateway-subscription",
          }),
        ),
        Effect.provide(fixture.harness),
        fixture.tape.guard,
      ),
    };
  });
