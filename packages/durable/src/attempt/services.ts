import type { ModelRef } from "@earendil-works/pi-durable";
import type { ChildBackend } from "@usine/agents/runtime";
import type { Effect, Option } from "effect";
import type { AttemptHubs } from "./hubs.ts";

/** What the usine extension's tool and task use from the runtime that installed them. */
export interface ExtensionServices {
  readonly hubs: AttemptHubs;
  readonly backend: ChildBackend["Service"];
  readonly defaultModel: Option.Option<ModelRef>;
  /**
   * Runs one program on the installing runtime's services. pi-durable calls
   * tools and task phases outside any usine fiber; the signal interrupts it.
   */
  readonly run: <A, E>(program: Effect.Effect<A, E>, signal: AbortSignal | undefined) => Promise<A>;
}
