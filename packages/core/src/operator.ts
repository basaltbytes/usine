import { Context, Effect, Option, Schema } from "effect";

/** A GitHub login used for member and operator attribution. */
export const OperatorLogin = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u, {
    message: "Expected a GitHub login",
  }),
).pipe(Schema.brand("OperatorLogin"));

export type OperatorLogin = typeof OperatorLogin.Type;

/** The authenticated member for the current request, or `None` outside an authenticated request. */
export const ActingMember = Context.Reference<Option.Option<OperatorLogin>>(
  "@usine/core/ActingMember",
  { defaultValue: Option.none },
);

/** Uses the authenticated member, or the supplied actor for a non-HTTP operation. */
export const requestActor = (fallback: Option.Option<OperatorLogin>) =>
  Effect.map(ActingMember, (member) => Option.orElse(member, () => fallback));
