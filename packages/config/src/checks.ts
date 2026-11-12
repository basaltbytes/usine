import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import { canonicalLabelName } from "@usine/core/label";
import type { CoordinatorKind } from "@usine/core/agent";
import { Option, Schema } from "effect";

export const nonBlankString = (message: string) =>
  Schema.String.check(Schema.isPattern(/\S/u, { message }));

/** Returns a filter that rejects two names GitHub treats as the same repository. */
export const uniqueRepositoryNames = <A>(nameOf: (value: A) => RepositoryName) =>
  Schema.makeFilter<ReadonlyArray<A>>(
    (values) =>
      new Set(values.map((value) => canonicalRepositoryName(nameOf(value)))).size === values.length,
    { message: "Expected unique repository names, ignoring case" },
  );

/** Returns a filter that rejects two names GitHub treats as the same label. */
export const uniqueLabelNames = <A>(nameOf: (value: A) => string) =>
  Schema.makeFilter<ReadonlyArray<A>>(
    (values) =>
      new Set(values.map((value) => canonicalLabelName(nameOf(value)))).size === values.length,
    { message: "Expected unique GitHub label names, ignoring case" },
  );

/**
 * Rejects outcome labels on a schedule loop: its runs have no issue or pull request to label, so
 * every run would fail after the agent finishes. `key` names the field in the reported path.
 */
export const scheduleWithoutOutcomeLabels = (key: string) =>
  Schema.makeFilter<{
    readonly trigger: { readonly on: string };
    readonly outcomeLabels: ReadonlyArray<string>;
  }>(
    ({ trigger, outcomeLabels }) =>
      trigger.on !== "schedule" ||
      outcomeLabels.length === 0 || {
        path: [key],
        issue: "Expected no outcome labels on a schedule loop, which has no item to label",
      },
  );

/**
 * Rejects a parent model or effort beside `coordinator: events`, whose Attempts have no parent
 * session to use them. `keys` name the fields in the reported paths.
 */
export const eventsWithoutParentBrain = (keys: {
  readonly parentModel: string;
  readonly parentEffort: string;
}) =>
  Schema.makeFilter<{
    readonly coordinator: Option.Option<CoordinatorKind> | CoordinatorKind;
    readonly parentModel: Option.Option<unknown>;
    readonly parentEffort: Option.Option<unknown>;
  }>((value) => {
    const coordinator = Option.isOption(value.coordinator)
      ? value.coordinator
      : Option.some(value.coordinator);
    if (!Option.contains(coordinator, "events")) return true;
    return (["parentModel", "parentEffort"] as const)
      .filter((field) => Option.isSome(value[field]))
      .map((field) => ({
        path: [keys[field]],
        issue: `Expected no ${keys[field]} with coordinator: events, which runs no parent session`,
      }));
  });
