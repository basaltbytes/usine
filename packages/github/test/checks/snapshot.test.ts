import { assert, it } from "@effect/vitest";
import { ItemNumber } from "@usine/core/item";
import { Effect } from "effect";
import { GitHubChecks } from "../../src/checks.ts";
import { head, json, repository, withClient } from "./support.ts";

it.effect.each([
  { mergeable: "CONFLICTING", rollup: null, expected: "conflict" },
  { mergeable: "UNKNOWN", rollup: null, expected: "pending" },
  { mergeable: "MERGEABLE", rollup: null, expected: "pending" },
  { mergeable: "CONFLICTING", rollup: "PENDING", expected: "pending" },
  { mergeable: "CONFLICTING", rollup: "SUCCESS", expected: "success" },
  { mergeable: "MERGEABLE", rollup: "SUCCESS", expected: "success" },
  { mergeable: "MERGEABLE", rollup: "FAILURE", expected: "failure" },
  { mergeable: "MERGEABLE", rollup: "ERROR", expected: "failure" },
])("reads $mergeable with check rollup $rollup as $expected", ({ mergeable, rollup, expected }) =>
  Effect.gen(function* () {
    const snapshot = yield* (yield* GitHubChecks).snapshot(repository, ItemNumber.make(815));
    assert.strictEqual(snapshot.head, head);
    assert.strictEqual(snapshot.state, expected);
  }).pipe(
    Effect.provide(
      withClient(() =>
        json({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefOid: head,
                headRef: { target: { oid: head } },
                mergeable,
                statusCheckRollup: rollup === null ? null : { state: rollup },
              },
            },
          },
        }),
      ),
    ),
  ),
);

it.effect.each(["SUCCESS", "FAILURE", null])(
  "waits for a lagging pull request head with old rollup %s before accepting its checks",
  (rollup) =>
    Effect.gen(function* () {
      const snapshot = yield* (yield* GitHubChecks).snapshot(repository, ItemNumber.make(815));
      assert.strictEqual(snapshot.head, head);
      assert.strictEqual(snapshot.state, "pending");
    }).pipe(
      Effect.provide(
        withClient(() =>
          json({
            data: {
              repository: {
                pullRequest: {
                  state: "OPEN",
                  headRefOid: "b".repeat(40),
                  headRef: { target: { oid: head } },
                  mergeable: "CONFLICTING",
                  statusCheckRollup: rollup === null ? null : { state: rollup },
                },
              },
            },
          }),
        ),
      ),
    ),
);

it.effect.each([
  { state: "OPEN", headRef: { target: null }, expected: "open" },
  { state: "CLOSED", headRef: null, expected: "closed" },
  { state: "MERGED", headRef: { target: null }, expected: "merged" },
] as const)(
  "reads a $state pull request whose branch target is $headRef as $expected at its head",
  ({ state, headRef, expected }) =>
    Effect.gen(function* () {
      const snapshot = yield* (yield* GitHubChecks).snapshot(repository, ItemNumber.make(815));
      assert.strictEqual(snapshot.head, head);
      assert.strictEqual(snapshot.pullRequestState, expected);
      assert.strictEqual(snapshot.state, "success");
    }).pipe(
      Effect.provide(
        withClient(() =>
          json({
            data: {
              repository: {
                pullRequest: {
                  state,
                  headRefOid: head,
                  headRef,
                  mergeable: "MERGEABLE",
                  statusCheckRollup: { state: "SUCCESS" },
                },
              },
            },
          }),
        ),
      ),
    ),
);
