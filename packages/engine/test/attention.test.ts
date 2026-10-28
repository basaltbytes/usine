import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { InstanceDirectory } from "@usine/core/instance";
import { OperatorLogin } from "@usine/core/operator";
import { DateTime, Effect, FileSystem, Layer, Option } from "effect";
import {
  AttentionAcknowledgement,
  AttentionAcknowledgements,
  AttentionKey,
  AttentionRevision,
} from "../src/attention/attention.ts";
import { localSqliteLayer } from "../src/database/local-sqlite.ts";
import { RunReader } from "../src/run-reader/run-reader.ts";

it.effect(
  "persists who dismissed each revision across restarts and invalidates projections on dismissal and undo",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(yield* fs.makeTempDirectoryScoped());
      const acknowledgement = new AttentionAcknowledgement({
        id: "preflight:project:label",
        revision: AttentionRevision.make("first finding"),
        dismissedBy: Option.some(OperatorLogin.make("operator")),
        dismissedAt: DateTime.makeUnsafe("2026-10-28T12:00:00Z"),
      });
      const next = new AttentionAcknowledgement({
        ...acknowledgement,
        revision: AttentionRevision.make("changed finding"),
        dismissedBy: Option.none(),
      });
      const open = () =>
        Layer.merge(AttentionAcknowledgements.layer, RunReader.layer).pipe(
          Layer.provide(localSqliteLayer(directory)),
        );
      yield* Effect.gen(function* () {
        const store = yield* AttentionAcknowledgements;
        const reader = yield* RunReader;
        const before = yield* reader.revision();
        yield* store.dismiss(acknowledgement);
        const after = yield* reader.revision();
        assert.notDeepEqual(before, after);
        yield* store.dismiss(
          new AttentionAcknowledgement({ ...acknowledgement, dismissedBy: Option.none() }),
        );
        assert.deepStrictEqual(yield* reader.revision(), after);
        assert.deepStrictEqual(yield* store.list(), [acknowledgement]);
        yield* store.dismiss(next);
      }).pipe(Effect.provide(open()));
      yield* Effect.gen(function* () {
        const store = yield* AttentionAcknowledgements;
        const reader = yield* RunReader;
        assert.sameDeepMembers([...(yield* store.list())], [acknowledgement, next]);
        const before = yield* reader.revision();
        yield* store.undo(new AttentionKey(acknowledgement));
        assert.notDeepEqual(yield* reader.revision(), before);
        assert.deepStrictEqual(yield* store.list(), [next]);
        yield* store.undo(new AttentionKey(acknowledgement));
        assert.deepStrictEqual(yield* store.list(), [next]);
      }).pipe(Effect.provide(open()));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
