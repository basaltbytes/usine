import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { ItemKey } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { CycleBudgetReset, type CycleBudgets } from "@usine/engine/cycle-budget";
import { GitHubApiError } from "@usine/github/github-app";
import {
  EntityTag,
  type GitHubPolling,
  PollCursor,
  RepositoryChanges,
  RepositoryLabelCatalog,
} from "@usine/github/polling";
import { DateTime, Effect, Option, Schema } from "effect";
import { PollingTriggers } from "../src/polling-triggers.ts";
import { emptyCycleBudgets, memoryCursorStore, pollingTestLayer } from "./support/polling.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const instance = new LoadedInstance({
  config: Schema.decodeUnknownSync(UsineConfig)({ version: 1, repos: [{ name: repository }] }),
  agents: [],
  invalidAgents: [],
  loops: [],
  quarantinedLoops: [],
  warnings: [],
});

describe("cycle reset polling", () => {
  it.effect(
    "restarts cursors after reset, retains failed refreshes, and continues a committed backlog",
    () => {
      const cursors = memoryCursorStore();
      const fresh = new PollCursor({
        entityTag: Option.some(EntityTag.make('"fresh"')),
        watermark: Option.some(DateTime.makeUnsafe("2026-09-05T00:00:00Z")),
      });
      const reset = Schema.decodeUnknownSync(CycleBudgetReset)({
        itemKey: ItemKey.make("pr-72"),
        repository,
        generation: 1,
      });
      let pending: ReadonlyArray<CycleBudgetReset> = [];
      let fails = false;
      const seen: Array<PollCursor> = [];
      const acknowledgements: Array<CycleBudgetReset> = [];
      const budgets: CycleBudgets["Service"] = {
        ...emptyCycleBudgets,
        pendingResets: () => Effect.sync(() => pending),
        acknowledgeReset: (value) =>
          Effect.sync(() => {
            // Cursor progress must already be durable when the reset is acknowledged.
            assert(cursors.stored.size > 0);
            acknowledgements.push(value);
            pending = [];
          }),
      };
      const github: GitHubPolling["Service"] = {
        labels: () =>
          Effect.succeed(new RepositoryLabelCatalog({ labels: [], entityTag: Option.none() })),
        snapshot: () => Effect.die("no Items on this page"),
        changes: (_repository, cursor) =>
          Effect.gen(function* () {
            seen.push(cursor);
            if (fails)
              return yield* new GitHubApiError({
                operation: "poll-repository-changes",
                status: Option.some(503),
                message: "unavailable",
              });
            return new RepositoryChanges({
              cursor: fresh,
              items: [],
              backlog: true,
              nextPollAt: Option.none(),
            });
          }),
      };
      return Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        yield* polling.poll(instance);
        yield* polling.poll(instance);
        assert.deepStrictEqual(seen[1], fresh);
        pending = [reset];
        fails = true;
        assert.strictEqual((yield* polling.poll(instance)).failures.length, 1);
        assert.deepStrictEqual(seen[2], PollCursor.empty);
        assert.deepStrictEqual(pending, [reset]);
        assert.deepStrictEqual(acknowledgements, []);
        fails = false;
        yield* polling.poll(instance);
        assert.deepStrictEqual(seen[3], PollCursor.empty);
        assert.deepStrictEqual(acknowledgements, [reset]);
        yield* polling.poll(instance);
        assert.deepStrictEqual(seen[4], fresh);
      }).pipe(
        Effect.provide(pollingTestLayer(github, [], undefined, undefined, cursors.store, budgets)),
      );
    },
  );
});
