import { Link, useNavigate } from "@tanstack/react-router";
import type {
  AgentFileView,
  ConfigurationView,
  InvalidAgentView,
} from "@usine/orchestrator/operator";
import { Markdown } from "@/components/markdown";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { harnessLabel, plural } from "./copy.ts";
import { FileError } from "./file-error.tsx";
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
} from "./section.tsx";

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
          <span className="font-sans text-sm text-muted-foreground">Pi selects</span>
        )}
      </TableCell>
      <TableCell className="hidden w-full whitespace-normal text-muted-foreground md:table-cell">
        {agent.loops.length === 0 ? "No Loop" : agent.loops.join(", ")}
      </TableCell>
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

/** Every Agent file: the ones that did not load first, then the roster, each opening its detail. */
export const AgentsList = ({ configuration }: { readonly configuration: ConfigurationView }) => (
  <ConfigurationPage title="Agents" counts={agentCounts(configuration)}>
    {configuration.agents.length === 0 && configuration.invalidAgents.length === 0 ? (
      <Missing title="No Agents">
        Add a Markdown file under <code>agents/</code> in the instance folder, then reload the
        configuration. Every Loop names the Agent that runs it.
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
              <TableHead className="hidden w-full md:table-cell">Loops</TableHead>
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

/** Where a parent setting comes from: this file, `settings` in `usine.yaml`, or the fallback. */
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
        <Unset>Pi selects it</Unset>
      ) : (
        <code className="font-mono text-xs">{agent.resolvedParentModel}</code>
      )}
      <Source>
        {agent.parentModel !== null
          ? "Set in this file"
          : configuration.settings.parentModel !== null
            ? "From settings.parent_model"
            : "Neither this file nor settings sets one"}
      </Source>
    </Fact>
    <Fact label="Parent effort">
      {agent.resolvedParentEffort}
      <Source>
        {agent.parentEffort !== null
          ? "Set in this file"
          : configuration.settings.parentEffort !== null
            ? "From settings.parent_effort"
            : "The Agent's own effort"}
      </Source>
    </Fact>
    <Fact label="Loops">
      {agent.loops.length === 0 ? (
        <Unset>No Loop names this Agent</Unset>
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

/** One Agent file in full: its persona beside its brain and the Loops that name it, or why it did
 * not load; `name` is the file's name without `.md`. */
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
          <DetailSection title="Persona" aside="Given to the Agent with every task">
            <Markdown className="max-w-[72ch] text-md">{agent.persona}</Markdown>
          </DetailSection>
        </DetailColumns>
      </ConfigurationPage>
    );
  const invalid = configuration.invalidAgents.find((candidate) => candidate.name === name);
  if (invalid !== undefined)
    return (
      <ConfigurationPage title={invalid.name} marks={<NotLoaded />} file={invalid.file}>
        <FileError
          error={invalid.error}
          consequence="The Agent is not in the roster, and every Loop that names it is quarantined."
        />
      </ConfigurationPage>
    );
  return (
    <ConfigurationPage title={name}>
      <Missing title="No Agent by this name">
        The configuration has no file <code>agents/{name}.md</code>.{" "}
        <Link to="/configuration/agents" className="text-primary hover:underline">
          See every Agent
        </Link>
        .
      </Missing>
    </ConfigurationPage>
  );
};
