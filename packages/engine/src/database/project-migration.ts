import { getTableName } from "drizzle-orm";
import { projectMigrationDialect } from "./dialect.ts";
import {
  loopItems,
  events,
  triggerEvents,
  cycleReservations,
  itemCycleBudgets,
  runs,
  loopRuntime,
  cycleAskClosures,
  attentionAcknowledgements,
} from "./schema.ts";
import { ProjectId } from "@usine/core/project";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { type Brand, Effect, Option, Predicate, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { EnginePersistenceError } from "../engine/error.ts";

/**
 * A managed repo and its project assignment, used to qualify stored loop identities during
 * migration.
 */
export class RepositoryProject extends Schema.Class<
  RepositoryProject,
  Brand.Brand<"@usine/engine/database/project-migration/RepositoryProject">
>("RepositoryProject")({
  /**
   * The managed repo whose stored loop references need the project prefix; matching ignores case.
   */
  repository: RepositoryName,
  /** The project ID to prefix to unqualified loop identities. */
  project: ProjectId,
  /** Qualified identities of the project's authored loops. */
  loops: Schema.Array(LoopName),
}) {}

const Json = Schema.fromJsonString(Schema.Json);
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => Predicate.isObject(value);

const qualifyJson = (
  value: Schema.Json,
  project: ProjectId,
  namespaces: ReadonlyMap<string, ProjectId>,
): Schema.Json => {
  if (Array.isArray(value)) return value.map((entry) => qualifyJson(entry, project, namespaces));
  if (!isJsonObject(value)) return value;
  const owner = Predicate.isString(value.repository)
    ? (namespaces.get(value.repository.toLowerCase()) ?? project)
    : project;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "loop" && Predicate.isString(entry) && !entry.includes("/")
        ? `${owner}/${entry}`
        : qualifyJson(entry, owner, namespaces),
    ]),
  );
};

/**
 * Qualifies stored loop references using the repository-to-project assignments in `projects`.
 * Preserves run and event IDs and leaves qualified identities unchanged. Run inside the caller's
 * configuration transaction, before the engine starts; failures return `EnginePersistenceError`.
 */
export const migrateProjectLoops = Effect.fn("RunDatabase.migrateProjectLoops")(
  function* (projects: ReadonlyArray<RepositoryProject>) {
    const sql = yield* SqlClient.SqlClient;
    const dialect = projectMigrationDialect(sql);
    const namespaces = new Map(
      projects.map(({ repository, project }) => [repository.toLowerCase(), project]),
    );
    yield* Effect.annotateCurrentSpan({
      repositories: projects.map(({ repository }) => repository),
    });
    for (const { repository, project, loops } of projects) {
      // Item identities keep their repository, including schedule items without a number.
      yield* sql`UPDATE ${sql(getTableName(loopItems))} SET loop_name = ${project} || '/' || loop_name
        WHERE ${dialect.unqualified(sql.literal("loop_name"))} AND (item_key IN
          (SELECT item_key FROM ${sql(getTableName(triggerEvents))} WHERE lower(repository) = lower(${repository}))
          OR CASE WHEN ${dialect.jsonValid(sql.literal("item_key"))} THEN lower(${dialect.jsonExtract(sql.literal("item_key"), "$[1]")}) = lower(${repository}) ELSE 0 END)`;
      yield* sql`UPDATE ${sql(getTableName(events))} AS event SET dedup_key = ${dialect.jsonSet(sql.literal("event.dedup_key"), "$[0]", sql`${project} || '/' || ${dialect.jsonExtract(sql.literal("event.dedup_key"), "$[0]")}`)}
        WHERE ${dialect.jsonValid(sql.literal("event.dedup_key"))} AND EXISTS (
          SELECT 1 FROM ${sql(getTableName(triggerEvents))} AS trigger
          WHERE trigger.event_id = event.event_id AND lower(trigger.repository) = lower(${repository})
            AND ${dialect.unqualified(sql.literal("trigger.loop_name"))} AND ${dialect.jsonExtract(sql.literal("event.dedup_key"), "$[0]")} = trigger.loop_name)`;
      yield* sql`UPDATE ${sql(getTableName(cycleReservations))} SET loop = ${project} || '/' || loop
        WHERE ${dialect.unqualified(sql.literal("loop"))} AND item_key IN
          (SELECT item_key FROM ${sql(getTableName(itemCycleBudgets))} WHERE lower(repository) = lower(${repository}))`;
      yield* sql`UPDATE ${sql(getTableName(triggerEvents))} SET loop_name = ${project} || '/' || loop_name
        WHERE lower(repository) = lower(${repository}) AND ${dialect.unqualified(sql.literal("loop_name"))}`;
      yield* sql`UPDATE ${sql(getTableName(runs))} SET loop_name = ${project} || '/' || loop_name
        WHERE lower(repository) = lower(${repository}) AND ${dialect.unqualified(sql.literal("loop_name"))}`;
      if (loops.length > 0) {
        yield* sql`INSERT INTO ${sql(getTableName(loopRuntime))} (loop_name, paused)
          SELECT ${project} || '/' || loop_name, paused FROM ${sql(getTableName(loopRuntime))}
          WHERE ${dialect.unqualified(sql.literal("loop_name"))} AND ${sql.in(
            "loop_name",
            loops.map((loop) => loop.slice(project.length + 1)),
          )}
          ON CONFLICT(loop_name) DO UPDATE SET paused = excluded.paused`;
      }
      const asks =
        yield* sql`SELECT item_key AS key, ask_json AS value FROM ${sql(getTableName(itemCycleBudgets))}
        WHERE lower(repository) = lower(${repository}) AND ask_json IS NOT NULL`;
      for (const row of asks) {
        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ key: Schema.String, value: Json }),
        )(row);
        yield* sql`UPDATE ${sql(getTableName(itemCycleBudgets))} SET ask_json = ${JSON.stringify(qualifyJson(decoded.value, project, namespaces))} WHERE item_key = ${decoded.key}`;
      }
      const closed =
        yield* sql`SELECT ask_id AS key, ask_json AS value FROM ${sql(getTableName(cycleAskClosures))}
        WHERE lower(${dialect.jsonExtract(sql.literal("ask_json"), "$.repository")}) = lower(${repository})`;
      for (const row of closed) {
        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ key: Schema.String, value: Json }),
        )(row);
        yield* sql`UPDATE ${sql(getTableName(cycleAskClosures))} SET ask_json = ${JSON.stringify(qualifyJson(decoded.value, project, namespaces))} WHERE ask_id = ${decoded.key}`;
      }
    }
    const acknowledgements =
      yield* sql`SELECT id, revision, dismissed_by, dismissed_at FROM ${sql(getTableName(attentionAcknowledgements))}`;
    for (const row of acknowledgements) {
      const saved = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          id: Schema.String,
          revision: Schema.String,
          dismissed_by: Schema.NullOr(Schema.String),
          dismissed_at: Schema.String,
        }),
      )(row);
      const decoded = Schema.decodeOption(Json)(saved.revision);
      if (Option.isNone(decoded)) {
        yield* Effect.logDebug("Preserved opaque attention revision during project migration", {
          id: saved.id,
        });
        continue;
      }
      const value = decoded.value;
      const references = new Set<string>();
      const collectRepositories = (entry: Schema.Json): void => {
        if (Array.isArray(entry)) {
          entry.forEach(collectRepositories);
          return;
        }
        if (!isJsonObject(entry)) return;
        for (const [key, child] of Object.entries(entry)) {
          if (key === "repository" && Predicate.isString(child))
            references.add(child.toLowerCase());
          else collectRepositories(child);
        }
      };
      collectRepositories(value);
      const applicable = projects.filter(
        ({ repository }) => references.size === 0 || references.has(repository.toLowerCase()),
      );
      for (const { project } of applicable) {
        let updated = qualifyJson(value, project, namespaces);
        let id = saved.id;
        if (id.startsWith("schedule-failure:")) {
          const parts = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Array(Schema.Json)),
          )(id.slice("schedule-failure:".length));
          if (Predicate.isString(parts[0]) && !parts[0].includes("/")) {
            id = `schedule-failure:${JSON.stringify([`${project}/${parts[0]}`, ...parts.slice(1)])}`;
            if (isJsonObject(updated)) updated = { ...updated, id };
          }
        }
        const revision = JSON.stringify(updated);
        if (revision === saved.revision && id === saved.id) continue;
        yield* sql`INSERT INTO ${sql(getTableName(attentionAcknowledgements))} (id, revision, dismissed_by, dismissed_at)
          VALUES (${id}, ${revision}, ${saved.dismissed_by}, ${saved.dismissed_at}) ON CONFLICT DO NOTHING`;
        yield* sql`DELETE FROM ${sql(getTableName(attentionAcknowledgements))} WHERE id = ${saved.id} AND revision = ${saved.revision}`;
      }
    }
    yield* sql`DELETE FROM ${sql(getTableName(loopRuntime))} WHERE ${dialect.unqualified(sql.literal("loop_name"))}`;
    yield* Effect.logInfo("Migrated runtime loop identities to projects", {
      repositories: projects.length,
    });
  },
  Effect.mapError((cause) =>
    EnginePersistenceError.make({ operation: "migrate project loop identities", cause }),
  ),
);
