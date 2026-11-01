import { Context, Effect, Option, Schema } from "effect";

/** A GitHub login used for member and operator attribution. */
export const OperatorLogin = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u, {
    message: "Expected a GitHub login",
  }),
).pipe(Schema.brand("OperatorLogin"));

export type OperatorLogin = typeof OperatorLogin.Type;

/** An audit actor; the reserved local label cannot be a GitHub login. */
export const OperatorActor = Schema.Union([OperatorLogin, Schema.Literal("local admin")]);
export type OperatorActor = typeof OperatorActor.Type;
export const localActor: OperatorActor = "local admin";

/** The authenticated member for the current request, or `None` outside an authenticated request. */
export const ActingMember = Context.Reference<Option.Option<OperatorActor>>(
  "@usine/core/ActingMember",
  { defaultValue: Option.none },
);

/** Uses the authenticated member, or the supplied actor for a non-HTTP operation. */
export const requestActor = (fallback: Option.Option<OperatorActor>) =>
  Effect.map(ActingMember, (member) => Option.orElse(member, () => fallback));
