import { useHarnessLabel } from "~/lib/configuration/capabilities";
import { entityKey } from "~/features/configuration/lib/entities";
import { Link, useNavigate } from "@tanstack/react-router";
import type {
  AgentFileView,
  ConfigurationView,
  InvalidAgentView,
} from "@usine/orchestrator/operator";
import { FillCell } from "~/components/fill-cell";
import { Markdown } from "~/components/markdown";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { emptyListCopy, plural } from "~/features/configuration/strings";
import { ListEmpty } from "~/features/configuration/components/list-empty";
import { AgentModels } from "~/features/configuration/components/agent-models";
import { FileError } from "~/features/configuration/components/file-error";
import {
  ConfigurationPage,
  DetailColumns,
  DetailSection,
  Fact,
  Facts,
  Missing,
  NotLoaded,
  Unset,
} from "~/features/configuration/components/section";
import { OpeningRow, rowLinkClass } from "~/components/opening-row";
import { TextTooltip } from "~/components/text-tooltip";

const agentCounts = (configuration: ConfigurationView): string =>
  [
    plural(configuration.agents.length, "agent"),
    ...(configuration.invalidAgents.length > 0
      ? [`${configuration.invalidAgents.length} not loaded`]
      : []),
  ].join(", ");

type AgentRowProps = { readonly agent: AgentFileView };

const AgentRow = ({ agent }: AgentRowProps) => {
  const harnessLabel = useHarnessLabel();
  const navigate = useNavigate();
  const params = { agent: agent.name };
  return (
    <OpeningRow open={() => void navigate({ to: "/configuration/agents/$agent", params })}>
      <TableCell size="roomy">
        <Link
          to="/configuration/agents/$agent"
          params={params}
          onClick={(event) => event.stopPropagation()}
          className={rowLinkClass}
        >
          {agent.name}
        </Link>
      </TableCell>
      <TableCell>{harnessLabel(agent.harness)}</TableCell>
      <TableCell variant="mono">{agent.model}</TableCell>
      <TableCell className="hidden sm:table-cell">{agent.effort}</TableCell>
      <FillCell tone="muted" className="hidden whitespace-normal md:table-cell">
        {agent.loops.length === 0 ? "No loop" : agent.loops.join(", ")}
      </FillCell>
    </OpeningRow>
  );
};

type InvalidAgentRowProps = { readonly agent: InvalidAgentView };

const InvalidAgentRow = ({ agent }: InvalidAgentRowProps) => {
  const navigate = useNavigate();
  const params = { agent: agent.name };
  return (
    <OpeningRow open={() => void navigate({ to: "/configuration/agents/$agent", params })}>
      <TableCell size="roomy">
        <Link
          to="/configuration/agents/$agent"
          params={params}
          onClick={(event) => event.stopPropagation()}
          className={rowLinkClass}
        >
          {agent.name}
        </Link>
      </TableCell>
      <TableCell>
        <NotLoaded />
      </TableCell>
      <TableCell colSpan={3} className="max-w-0">
        <TextTooltip text={agent.error.message} repeats>
          <p className="truncate text-destructive">{agent.error.message}</p>
        </TextTooltip>
      </TableCell>
    </OpeningRow>
  );
};

type AgentsListProps = { readonly configuration: ConfigurationView };

export const AgentsList = ({ configuration }: AgentsListProps) => {
  const empty = configuration.agents.length === 0 && configuration.invalidAgents.length === 0;
  return (
    <ConfigurationPage
      title="Agents"
      createKind="agent"
      empty={empty}
      counts={agentCounts(configuration)}
    >
      {empty ? (
        <ListEmpty {...emptyListCopy.agent} />
      ) : (
        <div className="-mx-2">
          <Table>
            <TableHeader>
              <TableRow variant="static">
                <TableHead>Agent</TableHead>
                <TableHead>Harness</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="hidden sm:table-cell">Effort</TableHead>
                <TableHead className="hidden md:table-cell">Loops</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {configuration.invalidAgents.map((agent) => (
                <InvalidAgentRow key={agent.file} agent={agent} />
              ))}
              {configuration.agents.map((agent) => (
                <AgentRow key={agent.name} agent={agent} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </ConfigurationPage>
  );
};

type AgentFactsProps = { readonly agent: AgentFileView };

const AgentFacts = ({ agent }: AgentFactsProps) => {
  const harnessLabel = useHarnessLabel();
  return (
    <Facts>
      <Fact label="Harness">{harnessLabel(agent.harness)}</Fact>
      <Fact label="Model">
        <code className="font-mono text-xs">{agent.model}</code>
      </Fact>
      <Fact label="Effort">{agent.effort}</Fact>
      <Fact label="Loops">
        {agent.loops.length === 0 ? (
          <Unset>No loop uses this agent</Unset>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {agent.loops.map((loop) => (
              <li key={loop}>
                <Link
                  to="/configuration/loops/$loop"
                  params={{ loop }}
                  className="text-primary hover:underline"
                >
                  {loop}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Fact>
    </Facts>
  );
};

type AgentDetailProps = {
  readonly name: string;
  readonly configuration: ConfigurationView;
};

/** `name` is the Agent file name without `.md`. */
export const AgentDetail = ({ name, configuration }: AgentDetailProps) => {
  const agent = configuration.agents.find((candidate) => candidate.name === name);
  if (agent !== undefined)
    return (
      <ConfigurationPage entity={entityKey("agent", name)} title={agent.name} file={agent.file}>
        <DetailColumns facts={<AgentFacts agent={agent} />}>
          <DetailSection title="Persona" aside="Sent to the agent with every task">
            <Markdown className="max-w-[72ch] text-md">{agent.persona}</Markdown>
          </DetailSection>
          <AgentModels agent={agent} />
        </DetailColumns>
      </ConfigurationPage>
    );
  const invalid = configuration.invalidAgents.find((candidate) => candidate.name === name);
  if (invalid !== undefined)
    return (
      <ConfigurationPage
        entity={entityKey("agent", name)}
        title={invalid.name}
        marks={<NotLoaded />}
        file={invalid.file}
      >
        <FileError error={invalid.error} consequence="Loops that use this agent are not loaded." />
      </ConfigurationPage>
    );
  return (
    <ConfigurationPage entity={entityKey("agent", name)} title={name}>
      <Missing title="Agent not found">
        The configuration has no file <code>agents/{name}.md</code>.{" "}
        <Link to="/configuration/agents" className="text-primary hover:underline">
          See all agents
        </Link>
        .
      </Missing>
    </ConfigurationPage>
  );
};
