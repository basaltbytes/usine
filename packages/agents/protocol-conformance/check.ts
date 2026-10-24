/**
 * Type check of `src/protocol/codex.ts` against the pinned `@pwrdrvr/codex-app-server-protocol`
 * package. `tsconfig.conformance.json` compiles it with bundler module resolution, which that
 * package requires because its internal imports are extensionless; `pnpm check` fails here if the
 * types drift.
 */
import type { InitializeParams, ServerNotification } from "@pwrdrvr/codex-app-server-protocol";
import type {
  GetAccountParams,
  GetAccountResponse,
  ModelListParams,
  ModelListResponse,
  ThreadItem,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  UserInput,
} from "@pwrdrvr/codex-app-server-protocol/v2";
import type * as Ours from "../src/protocol/codex.ts";

type Mutable<T> =
  T extends ReadonlyArray<infer E>
    ? Array<Mutable<E>>
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;
type Extends<A, B> = [A] extends [B] ? true : false;
type Assert<_T extends true> = never;
/** True if every protocol value of type `P` is valid input to the decoder `S`. */
type Decodes<S extends { readonly Encoded: unknown }, P> = Extends<P, S["Encoded"]>;
type Params<M extends ServerNotification["method"]> = Extract<
  ServerNotification,
  { method: M }
>["params"];
type Item<T extends ThreadItem["type"]> = Extract<ThreadItem, { type: T }>;
type ToolItemType = (typeof Ours.ToolItem.Type)["type"];

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

export type AccountResponseConform = Assert<
  Decodes<typeof Ours.AccountResponse, GetAccountResponse>
>;
export type AccountUpdatedConform = Assert<
  Decodes<typeof Ours.AccountUpdated, Params<"account/updated">>
>;
export type ModelListResponseConform = Assert<
  Decodes<typeof Ours.ModelListResponse, ModelListResponse>
>;
export type ThreadStartResponseConform = Assert<
  Decodes<typeof Ours.ThreadStartResponse, ThreadStartResponse>
>;
export type TurnStartResponseConform = Assert<
  Decodes<typeof Ours.TurnStartResponse, TurnStartResponse>
>;
// `item` decodes as any JSON value, so the item decoders below check its types. The generated
// `JsonValue` in some items allows `undefined` object values, which JSON can't carry.
export type ItemNotificationConform = Assert<
  Extends<
    Omit<Params<"item/started"> | Params<"item/completed">, "item">,
    Omit<typeof Ours.ItemNotification.Encoded, "item">
  >
>;
export type UserMessageItemConform = Assert<
  Decodes<typeof Ours.UserMessageItem, Item<"userMessage">>
>;
export type UserTextInputConform = Assert<
  Decodes<typeof Ours.UserTextInput, Extract<UserInput, { type: "text" }>>
>;
export type AgentMessageItemConform = Assert<
  Decodes<typeof Ours.AgentMessageItem, Item<"agentMessage">>
>;
export type ToolItemTypesConform = Assert<Extends<ToolItemType, ThreadItem["type"]>>;
export type ToolItemConform = Assert<Decodes<typeof Ours.ToolItem, Item<ToolItemType>>>;
export type TurnCompletedConform = Assert<
  Decodes<typeof Ours.TurnCompleted, Params<"turn/completed">>
>;
export type ErrorNotificationConform = Assert<
  Decodes<typeof Ours.ErrorNotification, Params<"error">>
>;
export type TurnActivityConform = Assert<
  Decodes<typeof Ours.TurnActivity, Params<"item/started"> | Params<"item/agentMessage/delta">>
>;
export type RateLimitsUpdatedConform = Assert<
  Decodes<typeof Ours.RateLimitsUpdated, Params<"account/rateLimits/updated">>
>;
export type CodexTokenUsageConform = Assert<
  Decodes<typeof Ours.CodexTokenUsage, Params<"thread/tokenUsage/updated">>
>;
