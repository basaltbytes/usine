import { Schema } from "effect";

/**
 * GitHub login of the factory's human operator, as `usine.yaml` names it. The
 * web UI acts as this login, and only this login may answer an Ask (ADR 0017).
 */
export const OperatorLogin = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u, {
    message: "Expected a GitHub login",
  }),
).pipe(Schema.brand("OperatorLogin"));

export type OperatorLogin = typeof OperatorLogin.Type;
