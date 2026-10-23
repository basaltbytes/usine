import type { ModelRef } from "@earendil-works/pi-durable";
import type { ChildBackend } from "@usine/agents/runtime";
import type { Effect, Option } from "effect";
import type { AttemptHubs } from "./hubs.ts";

/** The runtime services that the usine extension's tool and task use. */
export interface ExtensionServices {
  readonly hubs: AttemptHubs;
  readonly backend: ChildBackend["Service"];
  readonly defaultModel: Option.Option<ModelRef>;
  /**
   * Runs `program` with the installing runtime's services and interrupts it when `signal` aborts.
   */
  readonly run: <A, E>(program: Effect.Effect<A, E>, signal: AbortSignal | undefined) => Promise<A>;
}
