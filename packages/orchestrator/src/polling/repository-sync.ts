import type { DeclaredLabel } from "@usine/config/label";
import { CycleGeneration } from "@usine/core/cycle-budget";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { RepositoryName, canonicalRepositoryName } from "@usine/core/repository";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionSource,
  ItemProjectionWriter,
} from "@usine/engine/item-projection";
import {
  RepositoryLabel,
  RepositoryLabelProjection,
  RepositoryLabelProjectionReader,
  RepositoryLabelProjectionWriter,
} from "@usine/engine/repository-label-projection";
import type { GitHubAppError } from "@usine/github/github-app";
import {
  type ChangedItem,
  EntityTag,
  GitHubPolling,
  RepositoryLabelCatalog,
  type RepositoryLabelDetection,
} from "@usine/github/polling";
import { DateTime, Effect, Option, Result, Schema } from "effect";
import { type LabelReconciliation, LabelReconciler } from "../label-reconciler.ts";
import {
  type InterruptedRepositoryCycle,
  latestPollAt,
  RepositoryPollFailure,
  repositoryFailureLogFields,
} from "./cycle.ts";

/**
 * Identifies one GitHub issue or pull request across its changing snapshots.
 * Encoding uses the canonical repository name and Item number; decoding lets
 * Board consumers locate the Item associated with a Run. Schedule Runs identify
 * the repository alone and do not decode as an Item.
 */
export const GitHubItemKey = Schema.toType(ItemKey).pipe(
  Schema.decodeTo(
    Schema.fromJsonString(Schema.Tuple([Schema.Literal("github"), RepositoryName, ItemNumber])),
  ),
);
// `toType` preserves the ItemKey brand on the encoded side, so the encoder
// produces the identity accepted by both the Board projection and Run engine.
const encodeGitHubItemKey = Schema.encodeSync(GitHubItemKey);

/** The identity the Board projection and the Run engine use for one Item of `repository`. */
export const gitHubItemKey = (repository: RepositoryName, number: number): ItemKey =>
  encodeGitHubItemKey([
    "github",
    RepositoryName.make(canonicalRepositoryName(repository)),
    ItemNumber.make(number),
  ]);

/** What one repository's label-catalog request gave its cycle. */
interface LabelCatalogCycle {
  readonly labelEntityTag: Option.Option<EntityTag>;
  /** True when the ETag changed; the cursor persists it even if no item changed. */
  readonly entityTagChanged: boolean;
  /**
   * The catalog GitHub confirmed this cycle: a fresh body, or the stored
   * projection a 304 vouches for. None when the request failed, so provisioning
   * waits for a confirmed catalog instead of re-creating labels the repository
   * already has.
   */
  readonly confirmedLabels: Option.Option<ReadonlyArray<RepositoryLabel>>;
  readonly failures: ReadonlyArray<RepositoryPollFailure>;
  readonly nextPollAt: Option.Option<DateTime.Utc>;
}

/** The reconciliation result when the cycle had no confirmed catalog to compare against. */
const DEFERRED_RECONCILIATION: LabelReconciliation = {
  labels: [],
  findings: [],
  catalogChanged: false,
  nextPollAt: Option.none(),
};

/**
 * Refreshes the stored label catalog that the Board and the label
 * preflight read. A failed request keeps the stored catalog and ETag and
 * defers provisioning; trigger evaluation runs from the change poll alone.
 */
const applyLabelCatalog = Effect.fn("PollingTriggers.applyLabelCatalog")(function* (
  repository: RepositoryName,
  labelEntityTag: Option.Option<EntityTag>,
  result: Result.Result<RepositoryLabelDetection, GitHubAppError>,
) {
  yield* Effect.annotateCurrentSpan({ repository });
  const repositoryLabelReader = yield* RepositoryLabelProjectionReader;
  const repositoryLabelWriter = yield* RepositoryLabelProjectionWriter;
  const unchanged = {
    labelEntityTag,
    entityTagChanged: false,
    confirmedLabels: Option.none(),
    failures: [],
    nextPollAt: Option.none(),
  } satisfies LabelCatalogCycle;
  if (Result.isFailure(result)) {
    const error = result.failure;
    if (error._tag === "GitHubRateLimitError") {
      yield* Effect.logWarning(
        "Label catalog rate-limited; kept the stored catalog and deferred label provisioning",
        {
          repository,
          operation: error.operation,
          retryAt: DateTime.formatIso(error.retryAt),
        },
      );
      return { ...unchanged, nextPollAt: Option.some(error.retryAt) };
    }
    yield* Effect.logError(
      "Label catalog request failed; kept the stored catalog, deferred label provisioning, and evaluated items anyway",
      {
        repository,
        ...repositoryFailureLogFields(error),
      },
    );
    return {
      ...unchanged,
      failures: [
        new RepositoryPollFailure({
          repository,
          errorTag: error._tag,
          message: error.message,
        }),
      ],
    };
  }
  const detection = result.success;
  if (!(detection instanceof RepositoryLabelCatalog)) {
    const projection = yield* repositoryLabelReader.get(repository);
    if (Option.isNone(projection)) {
      // The ETag vouches for a projection that is no longer stored, so drop
      // it and fetch the catalog in full next cycle.
      yield* Effect.logWarning(
        "Repository label catalog unchanged (304) but its projection is missing; refetching next cycle and deferring label provisioning",
        { repository },
      );
      return { ...unchanged, labelEntityTag: Option.none(), entityTagChanged: true };
    }
    yield* Effect.logDebug("Repository label catalog unchanged (304)", {
      repository,
    });
    return { ...unchanged, confirmedLabels: Option.some(projection.value.labels) };
  }
  const labels = detection.labels.map(
    ({ name, color, description }) =>
      new RepositoryLabel({ name, color: Option.some(color), description }),
  );
  yield* repositoryLabelWriter.replace(new RepositoryLabelProjection({ repository, labels }));
  return {
    ...unchanged,
    labelEntityTag: detection.entityTag,
    entityTagChanged: true,
    confirmedLabels: Option.some(labels),
  };
});

/**
 * Refreshes and reconciles one repository's Board label catalog before change
 * detection. Pass the catalog ETag from its stored poll cursor; the result gives
 * the ETag to persist after Item processing, plus preflight findings and backoff.
 * Failed catalog requests retain the stored projection and defer provisioning;
 * persistence failures stop the repository for retry.
 */
export const synchronizeLabels = Effect.fn("PollingTriggers.synchronizeLabels")(function* (
  repository: RepositoryName,
  declared: ReadonlyArray<DeclaredLabel>,
  entityTag: Option.Option<EntityTag>,
) {
  yield* Effect.annotateCurrentSpan({ repository });
  const github = yield* GitHubPolling;
  const labelReconciler = yield* LabelReconciler;
  const repositoryLabelWriter = yield* RepositoryLabelProjectionWriter;
  const result = yield* Effect.result(github.labels(repository, entityTag));
  const catalog = yield* applyLabelCatalog(repository, entityTag, result);
  const reconciliation = yield* Option.match(catalog.confirmedLabels, {
    onNone: () => Effect.succeed(DEFERRED_RECONCILIATION),
    onSome: (confirmed) => labelReconciler.reconcile(repository, declared, confirmed),
  });
  const preflight = {
    labelEntityTag: reconciliation.catalogChanged
      ? Option.none<EntityTag>()
      : catalog.labelEntityTag,
    entityTagChanged: catalog.entityTagChanged || reconciliation.catalogChanged,
    failures: catalog.failures,
    preflightFindings: reconciliation.findings,
    nextPollAt: latestPollAt([catalog.nextPollAt, reconciliation.nextPollAt]),
  };
  if (reconciliation.catalogChanged) {
    yield* repositoryLabelWriter
      .replace(new RepositoryLabelProjection({ repository, labels: reconciliation.labels }))
      .pipe(
        // Provisioning may have reported failures before projection storage
        // fails. Preserve those findings just as for a later Item failure.
        Effect.mapError((error): InterruptedRepositoryCycle => ({
          _tag: "InterruptedRepositoryCycle",
          error,
          failures: preflight.failures,
          preflightFindings: preflight.preflightFindings,
          nextPollAt: preflight.nextPollAt,
        })),
      );
  }
  return preflight;
});

/** A fetched snapshot paired with the allowance observed before its request began. */
export interface ObservedItem {
  readonly projection: ItemProjection;
  readonly cycleGeneration: CycleGeneration;
}

/**
 * Fetches a detected Item and durably updates its Board projection regardless of
 * whether any Loop applies. Evaluation uses the returned projection's snapshot,
 * identity and content hash, so Board observation and Run decisions agree.
 */
export const observeItem = Effect.fn("PollingTriggers.observeItem")(function* (
  repository: RepositoryName,
  changed: ChangedItem,
) {
  yield* Effect.annotateCurrentSpan({ repository, item: changed.number });
  const github = yield* GitHubPolling;
  const items = yield* ItemProjectionWriter;
  const budgets = yield* CycleBudgets;
  const itemKey = gitHubItemKey(repository, changed.number);
  const cycleGeneration = yield* budgets.generation(itemKey);
  const snapshot = yield* github.snapshot(repository, changed);
  const projection = new ItemProjection({
    itemKey,
    repository,
    source: ItemProjectionSource.make(changed._tag === "ChangedIssue" ? "issue" : "pr"),
    number: ItemNumber.make(changed.number),
    contentHash: ItemContentHash.make(snapshot.contentHash),
    payload: snapshot.payload,
  });
  yield* items.upsert(projection);
  yield* Effect.logDebug("Fetched changed-item snapshot", {
    repository,
    item: projection.number,
    stream: projection.source,
    contentHash: projection.contentHash,
  });
  return { projection, cycleGeneration } satisfies ObservedItem;
});

/**
 * Records in the Board projection of Item `number` that GitHub no longer has
 * it, so its card leaves the open lanes. True when this marked a stored
 * projection.
 */
export const markItemGone = Effect.fn("PollingTriggers.markItemGone")(function* (
  repository: RepositoryName,
  number: number,
) {
  yield* Effect.annotateCurrentSpan({ repository, item: number });
  const items = yield* ItemProjectionWriter;
  return yield* items.markGone(gitHubItemKey(repository, number), yield* DateTime.now);
});
