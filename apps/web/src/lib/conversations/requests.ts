import type { DateTime } from "effect";
import { Schema } from "effect";
import type { TurnMember } from "@usine/core/conversation";
import {
  type Allowance,
  AllowedAlways,
  AllowedOnce,
  type Answer,
  RequestAllowed,
  RequestDenied,
  StandingGrantId,
} from "@usine/core/permission-request";
import {
  allowedAlwaysLabel,
  allowedOnceLabel,
  callFailedLabel,
  callInterruptedLabel,
  callRanLabel,
  callRunningLabel,
  coveredByGrantLabel,
} from "~/lib/conversations/strings";
import type { Conversation, PermissionRequest } from "~/lib/conversations/timeline";

/**
 * Returns `conversation` with the request `id` answered by `member` at `at`, as the server stores
 * the answer before it runs the call.
 */
export const withAnswer = (
  conversation: Conversation,
  id: PermissionRequest["id"],
  answer: Answer,
  member: TurnMember,
  at: DateTime.Utc,
): Conversation => ({
  ...conversation,
  requests: conversation.requests.map((request) =>
    request.id !== id
      ? request
      : {
          ...request,
          answerable: false,
          state:
            answer === "deny"
              ? RequestDenied.make({ by: member, at })
              : RequestAllowed.make({
                  allowance:
                    answer === "always"
                      ? AllowedAlways.make({
                          by: member,
                          at,
                          grant: StandingGrantId.make(`${request.id}:grant`),
                        })
                      : AllowedOnce.make({ by: member, at }),
                }),
        },
  ),
});

/** Who allowed a call, and how, in words; `project` is the call's scope name. */
export const allowanceLabel = (allowance: Allowance, project: string): string => {
  switch (allowance._tag) {
    case "AllowedOnce":
      return allowedOnceLabel(allowance.by.login);
    case "AllowedAlways":
      return allowedAlwaysLabel(project, allowance.by.login);
    case "CoveredByGrant":
      return coveredByGrantLabel(allowance.by.login);
  }
};

/** What an allowed call did, in words, with the state mark it shows. */
export const callOutcome = (
  state: Extract<PermissionRequest["state"], { readonly allowance: Allowance }>,
) => {
  switch (state._tag) {
    case "Allowed":
      return { mark: "Running", label: callRunningLabel } as const;
    case "Ran":
      return { mark: "Succeeded", label: callRanLabel } as const;
    case "Failed":
      return { mark: "Failed", label: callFailedLabel } as const;
    case "Interrupted":
      return { mark: "Failed", label: callInterruptedLabel } as const;
  }
};

/** The tone of a request's state, which picks its mark. */
export type RequestTone = "waiting" | "running" | "ran" | "failed" | "denied" | "interrupted";

export const requestTone = ({ state }: PermissionRequest): RequestTone => {
  switch (state._tag) {
    case "Waiting":
      return "waiting";
    case "Allowed":
      return "running";
    case "Ran":
      return "ran";
    case "Failed":
      return "failed";
    case "Denied":
      return "denied";
    case "Interrupted":
      return "interrupted";
  }
};

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));
const isScalar = Schema.is(Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]));

/** One argument of a call, with its value as text: a scalar as it is, other values as JSON. */
export interface ArgumentRow {
  readonly name: string;
  readonly value: string;
}

const valueText = (value: Schema.Json) => (isScalar(value) ? String(value) : JSON.stringify(value));

/**
 * Returns the arguments of a call as rows: the path and query parameters, then the fields of the
 * body, each by its own name.
 */
export const argumentRows = (args: PermissionRequest["arguments"]): ReadonlyArray<ArgumentRow> =>
  Object.entries(args).flatMap(([name, value]) =>
    name === "body" && isRecord(value)
      ? Object.entries(value).map(([field, inner]) => ({ name: field, value: valueText(inner) }))
      : [{ name, value: valueText(value) }],
  );

/** The most characters of arguments that a request shows open; longer ones start folded. */
const OPEN_ARGUMENTS = 240;

/** Whether the arguments are short enough to show open. */
export const argumentsFit = (rows: ReadonlyArray<ArgumentRow>): boolean =>
  rows.reduce((total, { name, value }) => total + name.length + value.length, 0) <=
    OPEN_ARGUMENTS && rows.every(({ value }) => !value.includes("\n"));
