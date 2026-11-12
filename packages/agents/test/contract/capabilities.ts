import { assert } from "@effect/vitest";
import type { Harness } from "@usine/core/agent/brain";
import type { AgentSessionEvent } from "@usine/core/agent/session";
import { Option } from "effect";
import type { Capability } from "../../src/harness/capability.ts";
import { catalog } from "../../src/harness/catalog.ts";
import { completionScenarios } from "../replay/completion.ts";
import { piScenarios, type Provider, scenarios } from "../replay/fixture.ts";
import type { Scenario } from "../replay/transcript.ts";

/**
 * A scenario of the contract suite. The recorded ones are `Scenario`s; the rest name the scenarios
 * that the adapter steps for tool sets add, which no adapter passes yet.
 */
export type ContractScenario = Scenario | "host-tool" | "closed-tools";

/** How the contract suite proves that a harness provides a capability. */
export type Proof =
  | {
      readonly _tag: "Scenarios";
      /** Every scenario must replay for the harness that declares the capability. */
      readonly scenarios: readonly [ContractScenario, ...Array<ContractScenario>];
    }
  | {
      readonly _tag: "Suites";
      /**
       * The test files, relative to this package, that check the capability for each harness. A
       * harness without an entry may not declare the capability.
       */
      readonly files: Partial<Record<Provider, readonly [string, ...Array<string>]>>;
      /** Why no session scenario shows the capability. */
      readonly reason: string;
    };

const proven = (...names: readonly [ContractScenario, ...Array<ContractScenario>]): Proof => ({
  _tag: "Scenarios",
  scenarios: names,
});

/** The scenarios that prove each capability. A descriptor may declare only what they prove. */
export const capabilityProofs = {
  "resume-session": proven("restart"),
  steer: proven("steer"),
  interrupt: proven("interrupt-guidance"),
  "token-usage": proven("simple"),
  "cost-usd": proven("simple"),
  "usine-tools": proven("host-tool"),
  "closed-tools": proven("closed-tools"),
  "structured-output": proven("structured-result"),
  ephemeral: proven("ephemeral"),
  "durable-coordination": {
    _tag: "Suites",
    files: { pi: ["../durable/test/subagent-recovery.test.ts"] },
    reason: "The durable journal belongs to the parent session, which runs outside the adapters",
  },
  "plan-windows": {
    _tag: "Suites",
    files: { claude: ["test/pi/claude.test.ts"], codex: ["test/pi/codex/codex.test.ts"] },
    reason: "Rate windows come from the provider account, which the recorded scenarios don't vary",
  },
  "model-check": {
    _tag: "Suites",
    files: { codex: ["test/pi/codex/codex.test.ts"], pi: ["test/pi/pi.test.ts"] },
    reason: "An unknown model is a launch failure, which the recorded scenarios don't include",
  },
} satisfies Record<Capability, Proof>;

/**
 * The scenarios that the replay suites run for `harness`. Claude Code and Codex replay `restart`
 * and `credential-changed` through the durable parent in `@usine/durable`, and every harness
 * replays the completion scenarios in `completion.test.ts`.
 */
export const replayedScenarios = (harness: Harness): ReadonlyArray<Scenario> => [
  ...(harness === "pi"
    ? piScenarios
    : [...scenarios, "restart" as const, "credential-changed" as const]),
  ...completionScenarios,
];

/** The capabilities that `harness` declares for any placement and credential route. */
export const declaredCapabilities = (harness: Harness): ReadonlySet<Capability> =>
  new Set(
    Option.match(catalog.get(harness), {
      onNone: () => [],
      onSome: ({ capabilities }) => capabilities.flatMap(({ supported }) => supported),
    }),
  );

/**
 * Checks the events of a replayed `scenario` for each capability that `harness` declares and the
 * scenario proves, where the events show it: reported tokens, and reported USD for `cost-usd`.
 */
export const assertProvenCapabilities = (
  harness: Harness,
  scenario: Scenario,
  events: ReadonlyArray<AgentSessionEvent>,
): void => {
  const declared = declaredCapabilities(harness);
  const proves = (capability: Capability) => {
    const proof: Proof = capabilityProofs[capability];
    return (
      declared.has(capability) && proof._tag === "Scenarios" && proof.scenarios.includes(scenario)
    );
  };
  const usage = events.flatMap((event) => (event._tag === "SessionTokensUpdated" ? [event] : []));
  if (proves("token-usage"))
    assert(
      usage.some(({ totalTokens }) => totalTokens > 0),
      `${harness} declares token-usage but reports no tokens in ${scenario}`,
    );
  if (proves("cost-usd"))
    assert(
      usage.some(({ costUsd }) => Option.isSome(costUsd)),
      `${harness} declares cost-usd but reports no USD in ${scenario}`,
    );
};
