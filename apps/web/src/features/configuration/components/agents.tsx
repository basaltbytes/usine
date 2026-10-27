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
import { harnessLabel, plural } from "~/features/configuration/strings";
import { FileError } from "~/features/configuration/components/file-error";
import {
  ConfigurationPage,
  DetailColumns,
  DetailSection,
  Fact,
  Facts,
  Missing,
  NotLoaded,
  OpeningRow,
  rowLinkClass,
  Unset,
} from "~/features/configuration/components/section";

const agentCounts = (configuration: ConfigurationView): string =>
  [
    plural(configuration.agents.length, "agent"),
    ...(configuration.invalidAgents.length > 0
      ? [`${configuration.invalidAgents.length} not loaded`]
      : []),
  ].join(", ");

const AgentRow = ({ agent }: { readonly agent: AgentFileView }) => {
  const navigate = useNavigate();
  const params = { agent: agent.name };
  return (
    <OpeningRow open={() => void navigate({ to: "/configuration/agents/$agent", params })}>
      <TableCell className="py-3">
        <Link
          to="/configuration/agents/$agent"
          params={params}
          onClick={(event) => event.stopPropagation()}
          className={rowLinkClass}
        >
          {agent.name}
        </Link>
      </TableCell>
      <TableCell>{harnessLabel[agent.harness]}</TableCell>
      <TableCell className="font-mono text-xs">{agent.model}</TableCell>
      <TableCell className="hidden sm:table-cell">{agent.effort}</TableCell>
      <TableCell className="hidden font-mono text-xs lg:table-cell">
        {agent.resolvedParentModel ?? (
          <span className="font-sans text-sm text-muted-foreground">Chosen by Pi</span>
        )}
      </TableCell>
      <FillCell className="hidden whitespace-normal text-muted-foreground md:table-cell">
        {agent.loops.length === 0 ? "No loop" : agent.loops.join(", ")}
      </FillCell>
    </OpeningRow>
  );
};

const InvalidAgentRow = ({ agent }: { readonly agent: InvalidAgentView }) => {
  const navigate = useNavigate();
  const params = { agent: agent.name };
  return (
    <OpeningRow open={() => void navigate({ to: "/configuration/agents/$agent", params })}>
      <TableCell className="py-3">
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
      <TableCell colSpan={4} className="max-w-0">
        <p className="truncate text-destructive" title={agent.error.message}>
          {agent.error.message}
        </p>
      </TableCell>
    </OpeningRow>
  );
};

export const AgentsList = ({ configuration }: { readonly configuration: ConfigurationView }) => (
  <ConfigurationPage title="Agents" counts={agentCounts(configuration)}>
    {configuration.agents.length === 0 && configuration.invalidAgents.length === 0 ? (
      <Missing title="No agents">
        Add a Markdown file under <code>agents/</code> in the instance folder, then reload the
        configuration.
      </Missing>
    ) : (
      <div className="-mx-2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Agent</TableHead>
              <TableHead>Harness</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="hidden sm:table-cell">Effort</TableHead>
              <TableHead className="hidden lg:table-cell">Parent model</TableHead>
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

/** Renders the source of a parent setting: this file, `settings` in `usine.yaml`, or the fallback. */
const Source = ({ children }: { readonly children: string }) => (
  <p className="mt-0.5 text-xs text-muted-foreground">{children}</p>
);

const AgentFacts = ({
  agent,
  configuration,
}: {
  readonly agent: AgentFileView;
  readonly configuration: ConfigurationView;
}) => (
  <Facts>
    <Fact label="Harness">{harnessLabel[agent.harness]}</Fact>
    <Fact label="Model">
      <code className="font-mono text-xs">{agent.model}</code>
    </Fact>
    <Fact label="Effort">{agent.effort}</Fact>
    <Fact label="Parent model">
      {agent.resolvedParentModel === null ? (
        <Unset>Chosen by Pi</Unset>
      ) : (
        <code className="font-mono text-xs">{agent.resolvedParentModel}</code>
      )}
      <Source>
        {agent.parentModel !== null
          ? "Set in this file"
          : configuration.settings.parentModel !== null
            ? "From settings.parent_model"
            : "Not set in this file or in settings"}
      </Source>
    </Fact>
    <Fact label="Parent effort">
      {agent.resolvedParentEffort}
      <Source>
        {agent.parentEffort !== null
          ? "Set in this file"
          : configuration.settings.parentEffort !== null
            ? "From settings.parent_effort"
            : "Same as effort"}
      </Source>
    </Fact>
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

/** `name` is the Agent file name without `.md`. */
export const AgentDetail = ({
  name,
  configuration,
}: {
  readonly name: string;
  readonly configuration: ConfigurationView;
}) => {
  const agent = configuration.agents.find((candidate) => candidate.name === name);
  if (agent !== undefined)
    return (
      <ConfigurationPage title={agent.name} file={agent.file}>
        <DetailColumns facts={<AgentFacts agent={agent} configuration={configuration} />}>
          <DetailSection title="Persona" aside="Sent to the agent with every task">
            <Markdown className="max-w-[72ch] text-md">{agent.persona}</Markdown>
          </DetailSection>
        </DetailColumns>
      </ConfigurationPage>
    );
  const invalid = configuration.invalidAgents.find((candidate) => candidate.name === name);
  if (invalid !== undefined)
    return (
      <ConfigurationPage title={invalid.name} marks={<NotLoaded />} file={invalid.file}>
        <FileError error={invalid.error} consequence="Loops that use this agent are not loaded." />
      </ConfigurationPage>
    );
  return (
    <ConfigurationPage title={name}>
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
