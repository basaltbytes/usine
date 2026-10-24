/**
 * Type check of `src/protocol/codex.ts` against the pinned `@pwrdrvr/codex-app-server-protocol`
 * package. `tsconfig.conformance.json` compiles it with bundler module resolution, which that
 * package requires because its internal imports are extensionless; `pnpm check` fails here if the
 * types drift.
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
