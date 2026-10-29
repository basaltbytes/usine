import {
  ConfigurationEntityId,
  ConfigurationEntityKey,
  type ConfigurationEntityKind,
} from "@usine/config/configuration";
import type { ConfigurationView } from "@usine/orchestrator/operator";

export const entityKey = (kind: ConfigurationEntityKind, identifier: string) =>
  new ConfigurationEntityKey({ kind, identifier: ConfigurationEntityId.make(identifier) });

export const entityHref = ({ kind, identifier }: ConfigurationEntityKey): string => {
  switch (kind) {
    case "settings":
      return "/configuration/settings";
    case "repository":
      return `/configuration/repositories/${identifier.split("/").map(encodeURIComponent).join("/")}`;
    default:
      return `/configuration/${kind}s/${encodeURIComponent(identifier)}`;
  }
};

export const entityReferences = (
  key: ConfigurationEntityKey,
  configuration: ConfigurationView,
): readonly string[] => {
  const identifier: string = key.identifier;
  switch (key.kind) {
    case "agent":
      return (
        configuration.agents
          .find(({ name }) => name === identifier)
          ?.loops.map((name) => `loop ${name}`) ?? []
      );
    case "loop":
      return (
        configuration.loops
          .find(({ name }) => name === identifier)
          ?.repositories.map((name) => `project ${name}`) ?? []
      );
    case "project":
      return configuration.loops
        .filter(({ name }) => name.startsWith(`${identifier}/`))
        .map(({ name }) => `loop ${name}`);
    case "repository":
      return configuration.loops
        .filter(({ repositories }) => repositories.some((name) => name === identifier))
        .map(({ name }) => `loop ${name}`);
    case "label":
      return configuration.repositories
        .filter(({ declaredLabels }) => declaredLabels.some(({ name }) => name === identifier))
        .map(({ name }) => `project ${name}`);
    case "worker":
      return configuration.repositories.map(({ name }) => `project ${name}`);
    case "settings":
      return configuration.repositories.map(({ name }) => `project ${name}`);
  }
};

export const entityTemplate = (
  kind: ConfigurationEntityKind,
  identifier: string,
  agent: string,
): string => {
  switch (kind) {
    case "agent":
      return "---\nharness: codex\nmodel: gpt-6-astra\neffort: medium\n---\n\nComplete one repository task at a time. Follow the repository instructions, run the required checks, and record any blocker on the issue or pull request.\n";
    case "loop":
      return `---\ntrigger:\n  on: issue\n  if: item.state == "OPEN" && item.labels.nodes.exists(label, label.name == "ready-for-agent")\nagent: ${JSON.stringify(agent)}\n---\n\nComplete issue #{{ item.number }}: {{ item.title }}.\n`;
    case "worker":
      return `name: ${JSON.stringify(identifier)}\nkind: local\nmax_concurrent_attempts: 1\n`;
    case "project":
      return `id: ${JSON.stringify(identifier)}\nname: ${JSON.stringify(identifier)}\nrepositories: []\nlanes: []\n`;
    case "repository":
      return `name: ${JSON.stringify(identifier)}\n`;
    case "label":
      return `name: ${JSON.stringify(identifier)}\ncolor: "808080"\n`;
    case "settings":
      return "settings:\n  poll_interval: 60\n";
  }
};
