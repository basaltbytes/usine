/**
 * Conformance gate for the hand-written app-server protocol view.
 *
 * `src/protocol/codex.ts` re-declares the request shapes usine sends because
 * the generated upstream package only resolves under bundler-style module
 * resolution (its internal imports are extensionless). This file is compiled
 * by `tsconfig.conformance.json` under that resolution and is the one place
 * the exact-pinned package is read, so `pnpm check` fails here when the view
 * drifts from the generated wire types.
 */
import type { InitializeParams } from "@pwrdrvr/codex-app-server-protocol";
import type {
  GetAccountParams,
  GetAccountResponse,
  AccountUpdatedNotification,
  ModelListParams,
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
  TurnSteerParams,
} from "@pwrdrvr/codex-app-server-protocol/v2";
import type { AccountResponse, AccountUpdated } from "../src/protocol/codex.ts";
import type * as Ours from "../src/protocol/codex.ts";

type Mutable<T> =
  T extends ReadonlyArray<infer E>
    ? Array<Mutable<E>>
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;
type Extends<A, B> = [A] extends [B] ? true : false;
type Assert<_T extends true> = never;

export type InitializeParamsConform = Assert<
  Extends<Mutable<Ours.InitializeParams>, InitializeParams>
>;
export type ModelListParamsConform = Assert<
  Extends<Mutable<Ours.ModelListParams>, ModelListParams>
>;
export type ThreadStartParamsConform = Assert<
  Extends<Mutable<Ours.ThreadStartParams>, ThreadStartParams>
>;
export type TurnStartParamsConform = Assert<
  Extends<Mutable<Ours.TurnStartParams>, TurnStartParams>
>;
export type TurnSteerParamsConform = Assert<
  Extends<Mutable<Ours.TurnSteerParams>, TurnSteerParams>
>;
export type TurnInterruptParamsConform = Assert<
  Extends<Mutable<Ours.TurnInterruptParams>, TurnInterruptParams>
>;

export type GetAccountParamsConform = Assert<
  Extends<Mutable<Ours.GetAccountParams>, GetAccountParams>
>;
export type GetAccountResponseConform = Assert<
  Extends<GetAccountResponse, typeof AccountResponse.Type>
>;
export type AccountUpdatedConform = Assert<
  Extends<AccountUpdatedNotification, typeof AccountUpdated.Type>
>;
