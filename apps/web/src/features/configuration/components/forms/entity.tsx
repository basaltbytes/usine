import { LoopFields } from "~/features/configuration/components/forms/loop/fields";
import type { ConfigurationEntityKey } from "@usine/config/configuration";
import { ProjectFields } from "~/features/configuration/components/forms/project/fields";
import type { FormFieldsProps } from "~/features/configuration/lib/forms";
import { AgentFields } from "./agent";
import { WorkerFields } from "./worker";
import { SettingsFields } from "./settings";
import { RepositoryFields } from "./repository";

type EntityFieldsProps = FormFieldsProps & { readonly entity: ConfigurationEntityKey };
export const EntityFields = ({ entity, ...fields }: EntityFieldsProps) => {
  switch (entity.kind) {
    case "loop":
      return <LoopFields {...fields} name={entity.identifier} />;
    case "agent":
      return <AgentFields {...fields} />;
    case "worker":
      return <WorkerFields {...fields} />;
    case "settings":
      return <SettingsFields {...fields} />;
    case "project":
      return <ProjectFields {...fields} />;
    case "repository":
      return <RepositoryFields {...fields} />;
    default:
      return null;
  }
};
