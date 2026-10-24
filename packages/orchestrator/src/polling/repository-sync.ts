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
 * The stable key of a GitHub issue or pull request: the canonical repository name and Item number.
 * Schedule Run keys contain only the repository and don't decode as an Item.
 */
export const GitHubItemKey = Schema.toType(ItemKey).pipe(
  Schema.decodeTo(
    Schema.fromJsonString(Schema.Tuple([Schema.Literal("github"), RepositoryName, ItemNumber])),
  ),
);
// `toType` keeps the ItemKey brand on the encoded side, so the encoder produces the key used by
// both the Board projection and the Run engine.
const encodeGitHubItemKey = Schema.encodeSync(GitHubItemKey);

/**
 * Returns the key of Item `number` of `repository`, as used by the Board projection and the Run
 * engine.
 */
export const gitHubItemKey = (repository: RepositoryName, number: number): ItemKey =>
  encodeGitHubItemKey([
    "github",
    RepositoryName.make(canonicalRepositoryName(repository)),
    ItemNumber.make(number),
  ]);

/** The result of one repository's label catalog request in a cycle. */
interface LabelCatalogCycle {
  readonly labelEntityTag: Option.Option<EntityTag>;
  /** Whether the ETag changed; the cursor persists it even if no Item changed. */
  readonly entityTagChanged: boolean;
  /**
   * The catalog confirmed this cycle: a fresh body, or the stored projection on a 304. `None` if
   * the request failed, so provisioning waits instead of re-creating existing labels.
   */
  readonly confirmedLabels: Option.Option<ReadonlyArray<RepositoryLabel>>;
  readonly failures: ReadonlyArray<RepositoryPollFailure>;
  readonly nextPollAt: Option.Option<DateTime.Utc>;
}

/** The reconciliation result when the cycle has no confirmed catalog. */
const DEFERRED_RECONCILIATION: LabelReconciliation = {
  labels: [],
  findings: [],
  catalogChanged: false,
  nextPollAt: Option.none(),
};

/**
 * Refreshes the stored label catalog used by the Board and label preflight. On a failed request,
 * keeps the stored catalog and ETag and defers provisioning.
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
      // The ETag refers to a projection that is no longer stored, so drop it and fetch the full
      // catalog next cycle.
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
 * Refreshes and reconciles one repository's Board label catalog before change detection, and
 * returns the ETag to persist after Item processing. Fails on persistence errors.
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
        // Provisioning may have reported failures before projection storage fails. Keep those
        // findings, as for a later Item failure.
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

/** A fetched snapshot with the request allowance observed before the request. */
export interface ObservedItem {
  readonly projection: ItemProjection;
  readonly cycleGeneration: CycleGeneration;
}

/**
 * Fetches a detected Item and updates its Board projection whether or not any Loop applies.
 * Evaluation uses the returned projection, so Board observation and Run decisions agree.
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
 * Marks Item `number`'s Board projection as gone from GitHub, which removes its card from the open
 * lanes. Returns true if a stored projection was marked.
 */
export const markItemGone = Effect.fn("PollingTriggers.markItemGone")(function* (
  repository: RepositoryName,
  number: number,
) {
  yield* Effect.annotateCurrentSpan({ repository, item: number });
  const items = yield* ItemProjectionWriter;
  return yield* items.markGone(gitHubItemKey(repository, number), yield* DateTime.now);
});
