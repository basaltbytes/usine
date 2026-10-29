import type { ConfigurationEntityKey } from "@usine/config/configuration";
import { RepositoryName } from "@usine/core/repository";
import type { FormFieldsProps } from "~/features/configuration/lib/forms";
import { AgentFields } from "./agent";
import { WorkerFields } from "./worker";
import { SettingsFields } from "./settings";
import { RepositoryFields } from "./repository";

type EntityFieldsProps = FormFieldsProps & { readonly entity: ConfigurationEntityKey };
export const EntityFields = ({ entity, ...fields }: EntityFieldsProps) => {
  switch (entity.kind) {
    case "agent":
      return <AgentFields {...fields} />;
    case "worker":
      return <WorkerFields {...fields} />;
    case "settings":
      return <SettingsFields {...fields} />;
    case "repository":
      return <RepositoryFields {...fields} repository={RepositoryName.make(entity.identifier)} />;
    default:
      return null;
  }
};
