import { HarnessCatalog, HarnessDescriptor } from "../../src/harness/harness.ts";
import { claude } from "../../src/harness/claude/descriptor.ts";
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
} from "@usine/core/agent/session";
import { AgentName } from "@usine/core/agent";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { preflight } from "../../src/preflight/preflight.ts";
import { WorkerName } from "@usine/core/worker";
import { Array as Arr, Effect, Layer, Option, Stream } from "effect";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import {
  type ChildBackendService,
  ChildRequest,
  ChildBackend,
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

const backend = (selected: Harness): ChildBackendService => ({
  stop: () => Effect.void,
  launch: (found) =>
    Effect.succeed({
      session: found.session,
      events: Stream.empty,
      result: Effect.succeed(SessionResult.make({ message: selected })),
      steer: () => Effect.void,
      interrupt: Effect.void,
      intervene: () =>
        Effect.succeed(AttemptChannel.InterventionState.make({ held: false, paused: false })),
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
  it.effect("removes other harnesses' host configuration before launch", () => {
    const original = request(claude.id);
    const runtime: HarnessRuntime = {
      id: claude.id,
      stop: () => Effect.void,
      preflight: checkedPreflight(() => Effect.void),
      launch: (found) => {
        assert.deepStrictEqual(found.environment, {
          HOME: "/home/worker",
          PATH: "/usr/bin:/bin",
          CLAUDE_CONFIG_DIR: "/worker/claude",
        });
        return backend(claude.id).launch(found);
      },
    };
    return Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* ChildBackend).launch(
          ChildRequest.make({
            ...original,
            environment: {
              ...original.environment,
              CLAUDE_CONFIG_DIR: "/worker/claude",
              CODEX_HOME: "/worker/codex",
              USINE_GATEWAY_TOKEN: "other-harness-token",
            },
          }),
        );
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
