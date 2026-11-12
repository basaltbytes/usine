import { Context, Effect } from "effect";
import type { AuthError } from "../auth/model.ts";

/**
 * Revalidates a stream's original credentials, permission set, and operation ceiling before a
 * notice is sent.
 */
export const ChangeAccess = Context.Reference<Effect.Effect<void, AuthError>>(
  "@usine/server/ChangeAccess",
  { defaultValue: () => Effect.void },
);
