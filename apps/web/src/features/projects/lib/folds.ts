import { ProjectId } from "@usine/core/project";
import { BoardLaneId } from "@usine/orchestrator/operator";
import { Effect, Option, Schema } from "effect";

const LaneFold = Schema.Struct({ project: ProjectId, lane: BoardLaneId, folded: Schema.Boolean });
const archive = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    lanes: Schema.Array(LaneFold).check(Schema.isMaxLength(200)),
  }),
);
const decode = Schema.decodeUnknownOption(archive, { onExcessProperty: "error" });
const encode = Schema.encodeSync(archive);
const storageKey = "usine:board-lane-folds:v1";
const maximumLanes = 200;
const maximumSize = 64_000;

/**
 * Stores the operator's fold choice for the 200 most recently folded or opened lanes. If storage is
 * denied, corrupt, or full, skips persistence; `storage` is a getter because accessing
 * `localStorage` can throw.
 */
export const laneFoldMemory = (storage: () => Pick<Storage, "getItem" | "setItem">) => {
  const readArchive = () => {
    const raw = storage().getItem(storageKey);
    if (raw === null || raw.length > maximumSize) return [];
    return Option.match(decode(raw), { onNone: () => [], onSome: ({ lanes }) => lanes });
  };
  const recover = <A>(
    operation: "read" | "write",
    project: ProjectId,
    lane: BoardLaneId,
    action: () => A,
    fallback: A,
  ): A =>
    Effect.runSync(
      Effect.try({ try: action, catch: () => ({ operation, project, lane }) }).pipe(
        Effect.catch((failure) =>
          Effect.logWarning("Board lane fold storage unavailable", failure).pipe(
            Effect.as(fallback),
          ),
        ),
        Effect.withSpan(`LaneFold.${operation}`, { attributes: { project, lane } }),
      ),
    );
  return {
    /** Returns the saved choice, or null if the operator never folded or opened the lane. */
    read: (project: ProjectId, lane: BoardLaneId): boolean | null =>
      recover(
        "read",
        project,
        lane,
        () =>
          readArchive().find((entry) => entry.project === project && entry.lane === lane)?.folded ??
          null,
        null,
      ),
    write: (project: ProjectId, lane: BoardLaneId, folded: boolean): void => {
      recover(
        "write",
        project,
        lane,
        () => {
          const lanes = [
            { project, lane, folded },
            ...readArchive().filter((entry) => entry.project !== project || entry.lane !== lane),
          ].slice(0, maximumLanes);
          let serialized = encode({ version: 1, lanes });
          while (serialized.length > maximumSize && lanes.length > 1) {
            lanes.pop();
            serialized = encode({ version: 1, lanes });
          }
          storage().setItem(storageKey, serialized);
        },
        undefined,
      );
    },
  };
};
