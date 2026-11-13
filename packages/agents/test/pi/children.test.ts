import { HarnessCatalog, HarnessDescriptor } from "../../src/harness/harness.ts";
import { claude } from "../../src/harness/claude/descriptor.ts";
import { pi } from "../../src/harness/pi/descriptor.ts";
import { AdmissionContext, AdmittedBrain } from "../../src/harness/admission.ts";
import { RolePlacements, RoleSpec } from "../../src/harness/role.ts";
import { continuationPolicy } from "../../src/harness/continuation.ts";
import { SessionSpec, StartPrompt, StartResume } from "../../src/harness/contract.ts";
import { Harnesses, type HarnessRuntime, ProbeTarget } from "../../src/harness/node.ts";
import { checkedPreflight } from "../../src/harness/runtime.ts";
import { CapabilityProfile, Lacking } from "../../src/harness/capability.ts";
import { HarnessReady } from "@usine/core/agent/capability";
import { catalog } from "../../src/harness/catalog.ts";
import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  HarnessSession,
  HarnessSessionId,
  RoleName,
  RoleSession,
} from "@usine/core/agent/session";
import { AgentName } from "@usine/core/agent";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { preflight } from "../../src/preflight/preflight.ts";
import { WorkerName } from "@usine/core/worker";
import { Array as Arr, Effect, Layer, Option, Stream } from "effect";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import {
  ChildRequest,
  ChildBackend,
  RestartState,
  SessionResult,
  WorkingDirectory,
} from "../../src/runtime.ts";
import { childDispatcherLayer } from "../../src/harness/children.ts";

const request = (harness: Harness) =>
  ChildRequest.make({
    worker: WorkerName.make("worker-1"),
    machine: Option.none(),
    environment: { HOME: "/home/worker", PATH: "/usr/bin:/bin" },
    session: ChildSession.make({
      id: AgentSessionId.make(`child-${harness}`),
      parentId: AgentSessionId.make("parent-1"),
      agent: AgentName.make("developer"),
      brain: BrainSpec.make({
        harness,
        model: ModelId.make(`${harness}-model`),
        effort: "high",
      }),
    }),
    cwd: WorkingDirectory.make("/workspace/repo"),
    host: LocalProcess.make(),
    prompt: "Implement the focused task.",
  });

const backend = (selected: Harness): Pick<HarnessRuntime, "open" | "stop" | "complete"> => ({
  stop: () => Effect.void,
  complete: () => Effect.die(new Error("The test runs no completion")),
  open: (spec) =>
    Effect.succeed({
      running: {
        session: spec.session,
        events: Stream.empty,
        result: Effect.succeed(SessionResult.make({ message: selected })),
        steer: () => Effect.void,
        interrupt: Effect.void,
        intervene: () =>
          Effect.succeed(AttemptChannel.InterventionState.make({ held: false, paused: false })),
      },
      active: false,
      recover: () => Effect.void,
    }),
});

const extra = Harness.make("example");
const extended = HarnessCatalog.make({
  descriptors: [
    ...catalog.descriptors,
    HarnessDescriptor.make({ ...claude, id: extra, label: "Example" }),
  ],
});
const runtimes = extended.ids.map((id): HarnessRuntime => ({
  id,
  ...backend(id),
  preflight: checkedPreflight(() => Effect.void),
}));

describe("harness runtime registration", () => {
  it.effect("removes other harnesses' host configuration before launch and stop", () => {
    const original = request(claude.id);
    const seen: Array<{
      readonly operation: "open" | "stop";
      readonly environment: Readonly<Record<string, string | undefined>>;
    }> = [];
    const runtime: HarnessRuntime = {
      id: claude.id,
      complete: backend(claude.id).complete,
      stop: (spec) =>
        Effect.sync(() => {
          seen.push({ operation: "stop", environment: spec.environment });
        }),
      preflight: checkedPreflight(() => Effect.void),
      open: (spec, start, continuation) => {
        seen.push({ operation: "open", environment: spec.environment });
        return backend(claude.id).open(spec, start, continuation);
      },
    };
    const child = ChildRequest.make({
      ...original,
      environment: {
        ...original.environment,
        CLAUDE_CONFIG_DIR: "/worker/claude",
        CODEX_HOME: "/worker/codex",
        USINE_GATEWAY_TOKEN: "other-harness-token",
      },
    });
    const scopedEnvironment = {
      HOME: "/home/worker",
      PATH: "/usr/bin:/bin",
      CLAUDE_CONFIG_DIR: "/worker/claude",
    };
    return Effect.scoped(
      Effect.gen(function* () {
        const dispatcher = yield* ChildBackend;
        yield* dispatcher.launch(child);
        yield* dispatcher.stop(child);
        assert.deepStrictEqual(seen, [
          { operation: "open", environment: scopedEnvironment },
          { operation: "stop", environment: scopedEnvironment },
        ]);
      }),
    ).pipe(
      Effect.provide(
        childDispatcherLayer.pipe(
          Layer.provide(
            Harnesses.layerFrom(catalog, [
              runtime,
              ...catalog.ids
                .filter((id) => id !== claude.id)
                .map((id): HarnessRuntime => ({
                  id,
                  ...backend(id),
                  preflight: checkedPreflight(() => Effect.void),
                })),
            ]),
          ),
        ),
      ),
    );
  });

  it.effect("admits a role session before a registered runtime opens it", () => {
    const opened: Array<string> = [];
    const recording = (id: Harness): HarnessRuntime => ({
      id,
      complete: backend(id).complete,
      stop: () => Effect.void,
      preflight: checkedPreflight(() => Effect.void),
      open: (spec, start, continuation) => {
        opened.push(`${id}:${spec.admitted.context.placement}:${start._tag}`);
        return backend(id).open(spec, start, continuation);
      },
    });
    const withoutResume = HarnessDescriptor.make({
      ...claude,
      capabilities: Arr.map(claude.capabilities, (profile) =>
        CapabilityProfile.make({
          ...profile,
          supported: profile.supported.filter((capability) => capability !== "resume-session"),
          lacking: [
            ...profile.lacking,
            Lacking.make({ capability: "resume-session", reason: "No saved-session recovery" }),
          ],
        }),
      ),
    });
    // A role declared here, with no change to admission, runs on workers like a coding agent.
    const probe = RoleSpec.make({
      name: RoleName.make("contract-probe"),
      placement: RolePlacements.make({
        placements: ["local", "ssh", "container", "sandbox"],
        reason: "The contract probe runs on a worker",
      }),
      credential: Option.none(),
      nativeTools: "all",
      hostTools: false,
      persistence: "saved",
      interventions: true,
      output: "text",
    });
    const spec = (harness: Harness, route: AdmissionContext) => {
      const brain = BrainSpec.make({
        harness,
        model: ModelId.make(`${harness}-model`),
        effort: "high",
      });
      return SessionSpec.make({
        session: RoleSession.make({
          id: AgentSessionId.make(`role-${harness}`),
          role: probe.name,
          agent: AgentName.make("developer"),
          brain,
        }),
        // The registry admits the spec again, so an unchecked route reaches its refusal.
        admitted: AdmittedBrain.make({ role: probe, brain, context: route, pool: Option.none() }),
        host: LocalProcess.make(),
        worker: WorkerName.make("worker-1"),
        machine: Option.none(),
        cwd: WorkingDirectory.make("/remote/checkout"),
        environment: { HOME: "/home/worker", PATH: "/usr/bin:/bin" },
      });
    };
    const prompt = "Probe the contract.";
    return Effect.scoped(
      Effect.gen(function* () {
        const harnesses = yield* Harnesses;
        const open = Effect.fn(function* (selected: SessionSpec, resume: boolean) {
          const runtime = yield* harnesses.runtime(selected.session.brain.harness);
          const policy = yield* continuationPolicy(selected, prompt, RestartState.make({}));
          return yield* runtime.open(
            selected,
            resume
              ? StartResume.make({
                  reference: HarnessSession.make({
                    id: HarnessSessionId.make("saved"),
                    cwd: selected.cwd,
                  }),
                })
              : StartPrompt.make({ text: prompt }),
            policy,
          );
        });
        const remote = yield* open(
          spec(pi.id, AdmissionContext.make({ placement: "ssh", credential: "api-key" })),
          false,
        ).pipe(Effect.flip);
        assert.strictEqual(remote._tag, "AgentResultError");
        assert.include(remote.message, "pi cannot run as contract-probe at ssh: lacks ssh");
        const resumed = yield* open(
          spec(claude.id, AdmissionContext.make({ placement: "local", credential: "host-login" })),
          true,
        ).pipe(Effect.flip);
        assert.strictEqual(resumed._tag, "AgentResultError");
        assert.include(resumed.message, "resume-session");
        assert.deepStrictEqual(opened, []);
        const local = yield* open(
          spec(pi.id, AdmissionContext.make({ placement: "local", credential: "host-login" })),
          false,
        );
        assert.strictEqual((yield* local.running.result).message, pi.id);
        assert.deepStrictEqual(opened, [`${pi.id}:local:StartPrompt`]);
      }),
    ).pipe(
      Effect.provide(
        Harnesses.layerFrom(
          HarnessCatalog.make({
            descriptors: catalog.descriptors.map((descriptor) =>
              descriptor.id === claude.id ? withoutResume : descriptor,
            ),
          }),
          catalog.ids.map(recording),
        ),
      ),
    );
  });

  it.effect("refuses saved-session launch when its credential route lacks resume-session", () => {
    const descriptor = HarnessDescriptor.make({
      ...claude,
      capabilities: Arr.map(claude.capabilities, (profile) =>
        CapabilityProfile.make({
          ...profile,
          supported: profile.supported.filter((capability) => capability !== "resume-session"),
          lacking: [
            ...profile.lacking,
            Lacking.make({ capability: "resume-session", reason: "No saved-session recovery" }),
          ],
        }),
      ),
    });
    const source = HarnessCatalog.make({ descriptors: [descriptor] });
    const original = request(claude.id);
    return Effect.scoped(
      Effect.gen(function* () {
        const dispatcher = yield* ChildBackend;
        assert.strictEqual((yield* (yield* dispatcher.launch(original)).result).message, claude.id);
        const failure = yield* dispatcher
          .launch(
            ChildRequest.make({
              ...original,
              resume: Option.some(
                HarnessSession.make({ id: HarnessSessionId.make("saved"), cwd: original.cwd }),
              ),
            }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AgentResultError");
        assert.include(failure.message, "resume-session");
      }),
    ).pipe(
      Effect.provide(
        childDispatcherLayer.pipe(
          Layer.provide(
            Harnesses.layerFrom(source, [
              {
                id: claude.id,
                ...backend(claude.id),
                preflight: checkedPreflight(() => Effect.void),
              },
            ]),
          ),
        ),
      ),
    );
  });

  it.effect(
    "dispatches launch and preflight to every registered harness, including an added descriptor",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatcher = yield* ChildBackend;
          for (const harness of extended.ids) {
            const child = request(harness);
            const running = yield* dispatcher.launch(child);
            assert.strictEqual((yield* running.result).message, harness);
            const readiness = yield* preflight(
              child.session.brain,
              ProbeTarget.make({
                host: child.host,
                environment: child.environment,
                worker: child.worker,
                machine: child.machine,
                placement: "local",
                credential: "host-login",
              }),
            );
            assert.strictEqual(readiness._tag, "HarnessReady");
            assert.strictEqual(readiness.harness, harness);
          }
          const error = yield* dispatcher
            .launch(request(Harness.make("unknown")))
            .pipe(Effect.flip);
          assert(error._tag === "SessionOperationError");
          assert(Option.isSome(error.sessionId));
        }).pipe(
          Effect.provide(
            childDispatcherLayer.pipe(Layer.provideMerge(Harnesses.layerFrom(extended, runtimes))),
          ),
        ),
      ),
  );

  it.effect(
    "uses the registered credential provider for launch and refuses unsupported preflight routes",
    () => {
      const apiProfile = claude.capabilities.find((profile) =>
        profile.credentials.includes("api-key"),
      );
      assert(apiProfile !== undefined);
      const apiOnly = HarnessDescriptor.make({
        ...claude,
        id: extra,
        capabilities: [CapabilityProfile.make({ ...apiProfile, credentials: ["api-key"] })],
      });
      const activeCatalog = HarnessCatalog.make({ descriptors: [apiOnly] });
      return Effect.gen(function* () {
        const dispatcher = yield* ChildBackend;
        const base = request(extra);
        const child = ChildRequest.make({
          ...base,
          environment: { ANTHROPIC_API_KEY: "test-key" },
        });
        const running = yield* dispatcher.launch(child);
        assert.strictEqual((yield* running.result).message, extra);
        const refused = yield* dispatcher.launch(base).pipe(Effect.flip);
        assert.strictEqual(refused._tag, "AgentResultError");
        assert.include(refused.message, "credential-route");
        for (const credential of ["api-key", "host-login"] as const) {
          const readiness = yield* preflight(
            child.session.brain,
            ProbeTarget.make({
              host: child.host,
              environment: child.environment,
              worker: child.worker,
              machine: child.machine,
              placement: "local",
              credential,
            }),
          );
          assert.strictEqual(
            readiness._tag,
            credential === "api-key" ? "HarnessReady" : "HarnessUnavailableError",
          );
        }
      }).pipe(
        Effect.provide(
          childDispatcherLayer.pipe(
            Layer.provideMerge(
              Harnesses.layerFrom(activeCatalog, [
                { id: extra, ...backend(extra), preflight: checkedPreflight(() => Effect.void) },
              ]),
            ),
          ),
        ),
        Effect.scoped,
      );
    },
  );

  for (const [description, entries] of [
    ["a descriptor has no runtime", runtimes.slice(1)],
    [
      "a runtime has no descriptor",
      [
        ...runtimes,
        {
          ...backend(extra),
          id: Harness.make("orphan"),
          preflight: () => Effect.succeed(HarnessReady.make({ harness: extra })),
        },
      ],
    ],
    ["a runtime ID is duplicated", [...runtimes, ...runtimes]],
  ] as const) {
    it.effect(`refuses registration when ${description}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const error = yield* Layer.build(Harnesses.layerFrom(extended, entries)).pipe(
            Effect.flip,
          );
          assert.strictEqual(error._tag, "HarnessRegistrationError");
        }),
      ),
    );
  }
});
