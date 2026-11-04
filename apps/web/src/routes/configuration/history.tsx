import { createFileRoute } from "@tanstack/react-router";
import { ConfigurationEntityId, ConfigurationEntityKind } from "@usine/config/configuration";
import { Schema } from "effect";
import { ConfigurationHistory } from "~/features/configuration/components/editor/history/history";
import { HistoryFilter } from "~/features/configuration/components/editor/history/filter";
import { ConfigurationPage } from "~/features/configuration/components/section";
import { entityKey } from "~/features/configuration/lib/entities";
import { revisionsQuery } from "~/features/configuration/queries";
import { historyCopy } from "~/features/configuration/strings";

const History = () => {
  const { entity } = Route.useLoaderDeps();
  return (
    <ConfigurationPage title={historyCopy.title}>
      <HistoryFilter key={`filter:${entity?.key ?? "all"}`} entity={entity} />
      <ConfigurationHistory key={entity?.key ?? "all"} entity={entity} />
    </ConfigurationPage>
  );
};

const Search = Schema.Struct({
  kind: Schema.optionalKey(ConfigurationEntityKind),
  identifier: Schema.optionalKey(ConfigurationEntityId),
}).check(
  Schema.makeFilter(({ kind, identifier }) => (kind === undefined) === (identifier === undefined), {
    message: "History requires both an entity type and name",
  }),
);

export const Route = createFileRoute("/configuration/history")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  loaderDeps: ({ search }) => ({
    entity:
      search.kind === undefined || search.identifier === undefined
        ? undefined
        : entityKey(search.kind, search.identifier),
  }),
  loader: ({ context, deps }) =>
    context.queryClient.ensureInfiniteQueryData(revisionsQuery(deps.entity)),
  component: History,
});
