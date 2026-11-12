import {
  ArrowsClockwiseIcon,
  BookBookmarkIcon,
  GearSixIcon,
  HardDrivesIcon,
  KanbanIcon,
  RobotIcon,
  TagIcon,
  UsersIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ConfigurationEntityKey, ConfigurationEntityKind } from "@usine/config/configuration";
import type { ConfigurationView } from "@usine/orchestrator/operator";
import { FilterBar } from "~/components/filter/bar";
import type { FilterField } from "~/components/filter/field";
import { entityKey } from "~/features/configuration/lib/entities";
import { historyCopy } from "~/features/configuration/strings";
import { configurationQuery } from "~/lib/configuration/queries";

const fieldKinds: ReadonlyArray<readonly [ConfigurationEntityKind, Icon]> = [
  ["loop", ArrowsClockwiseIcon],
  ["agent", RobotIcon],
  ["worker", HardDrivesIcon],
  ["project", KanbanIcon],
  ["repository", BookBookmarkIcon],
  ["label", TagIcon],
  ["binding", UsersIcon],
  ["settings", GearSixIcon],
];

const identifiers = (
  kind: ConfigurationEntityKind,
  configuration: ConfigurationView,
): readonly string[] => {
  switch (kind) {
    case "loop":
      return configuration.loops.map(({ name }) => name);
    case "agent":
      return configuration.agents.map(({ name }) => name);
    case "worker":
      return configuration.workers.map(({ name }) => name);
    case "project":
      return configuration.projects.map(({ id }) => id);
    case "repository":
      return configuration.repositories.map(({ name }) => name);
    case "label":
      return configuration.labels.map(({ name }) => name);
    case "binding":
      return configuration.bindings.map(({ name }) => name);
    case "settings":
      return ["instance"];
  }
};

type HistoryFilterProps = { readonly entity?: ConfigurationEntityKey | undefined };

export const HistoryFilter = ({ entity }: HistoryFilterProps) => {
  const { data } = useSuspenseQuery(configurationQuery());
  const navigate = useNavigate({ from: "/configuration/history" });
  const fields: readonly FilterField<ConfigurationEntityKind>[] = fieldKinds.map(([kind, icon]) => {
    const names = identifiers(kind, data);
    // A filter from the URL can name an entity that no longer exists.
    const missing =
      entity?.kind === kind && !names.includes(entity.identifier) ? [entity.identifier] : [];
    return {
      id: kind,
      label: historyCopy.kinds[kind],
      icon,
      options: [...names, ...missing].map((name) => ({ value: name, label: name })),
    };
  });
  return (
    <FilterBar
      fields={fields}
      value={entity === undefined ? [] : [{ field: entity.kind, value: entity.identifier }]}
      onValueChange={(next) => {
        const latest = next.at(-1);
        const key = latest === undefined ? undefined : entityKey(latest.field, latest.value);
        void navigate({
          search: key === undefined ? {} : { kind: key.kind, identifier: key.identifier },
        });
      }}
    />
  );
};
