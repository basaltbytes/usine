import { CheckCircleIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { splitRepositoryName } from "@usine/core/repository";
import {
  FactoryConfigRefusal,
  OperatorHttpError,
  ReloadPreflightRefusal,
  type ReloadRefusal,
  RestartRequiredRefusal,
} from "@usine/orchestrator/operator/http";
import { createContext, Fragment, type ReactNode, use } from "react";
import {
  type ConfigurationReload,
  ReloadConfigurationButton,
  useReloadConfiguration,
} from "~/components/configuration/reload";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { clockLabel, reloadChanges } from "~/lib/strings";
import { capabilityLabel, reloadRefusalLead } from "~/features/configuration/strings";

const ReloadContext = createContext<ConfigurationReload | null>(null);

/** Provides one reload state to the Configuration section, so the result stays visible across its pages. */
export const SectionReloadProvider = ({ children }: { readonly children: ReactNode }) => (
  <ReloadContext value={useReloadConfiguration()}>{children}</ReloadContext>
);

const useSectionReload = (): ConfigurationReload => {
  const reload = use(ReloadContext);
  if (reload === null) throw new Error("useSectionReload is called outside SectionReloadProvider");
  return reload;
};

export const SectionReloadButton = () => <ReloadConfigurationButton reload={useSectionReload()} />;

const fileLink = (file: string) => {
  const [folder, name] = file.replace(/\.md$/u, "").split("/");
  if (name === undefined) return <code>{file}</code>;
  return folder === "loops" ? (
    <Link to="/configuration/loops/$loop" params={{ loop: name }}>
      <code>{file}</code>
    </Link>
  ) : (
    <Link to="/configuration/agents/$agent" params={{ agent: name }}>
      <code>{file}</code>
    </Link>
  );
};

const workerLink = (worker: string) => (
  <Link to="/configuration/workers/$worker" params={{ worker }}>
    <code>{worker}</code>
  </Link>
);

const agentLink = (agent: string) => (
  <Link to="/configuration/agents/$agent" params={{ agent }}>
    <code>{agent}</code>
  </Link>
);

/** Links a `usine.yaml` field path such as `workers.build-1.destination` to the page that shows it. */
const fieldLink = (field: string) => {
  const worker = /^workers\.([a-z0-9-]+)\.[a-z_]+$/u.exec(field)?.[1];
  if (worker !== undefined)
    return (
      <Link to="/configuration/workers/$worker" params={{ worker }}>
        <code>{field}</code>
      </Link>
    );
  if (field === "workers")
    return (
      <Link to="/configuration/workers">
        <code>{field}</code>
      </Link>
    );
  if (field === "webhooks" || field === "tracing")
    return (
      <Link to="/configuration/settings">
        <code>{field}</code>
      </Link>
    );
  return <code>{field}</code>;
};

const listed = (names: ReadonlyArray<string>, link: (name: string) => ReactNode) =>
  names.map((name, index) => (
    <Fragment key={name}>
      {index > 0 && ", "}
      {link(name)}
    </Fragment>
  ));

const reloadRefusalOf = (error: Error): ReloadRefusal | null =>
  error instanceof RestartRequiredRefusal ||
  error instanceof ReloadPreflightRefusal ||
  error instanceof FactoryConfigRefusal
    ? error
    : null;

/** Renders a link to each field, Agent, Worker, or repository listed in a reload rejection. */
const RefusalSubjects = ({ refusal }: { readonly refusal: ReloadRefusal }) => {
  switch (refusal.error) {
    case "FactoryConfigError":
      return null;
    case "RestartRequiredError":
      return (
        <ul>
          <li>Changed in usine.yaml: {listed(refusal.fields, fieldLink)}</li>
        </ul>
      );
    case "ReloadPreflightError": {
      const { cause, agents, workers } = refusal;
      return (
        <ul>
          <li>
            {cause._tag === "WorkerCapabilityError" && (
              <>
                Failed check: {capabilityLabel[cause.capability]} on worker{" "}
                {workerLink(cause.worker)}
              </>
            )}
            {cause._tag === "ExecutorOperationError" && (
              <>Failed worker operation: {cause.operation}</>
            )}
            {cause._tag === "CredentialUnavailableError" && (
              <>
                No credential for{" "}
                <Link
                  to="/configuration/repositories/$owner/$name"
                  params={splitRepositoryName(cause.repository)}
                >
                  <code>{cause.repository}</code>
                </Link>
              </>
            )}
          </li>
          {agents.length > 0 && (
            <li>
              Checked {agents.length === 1 ? "agent" : "agents"}: {listed(agents, agentLink)}
            </li>
          )}
          {workers.length > 0 && (
            <li>
              Checked {workers.length === 1 ? "worker" : "workers"}: {listed(workers, workerLink)}
            </li>
          )}
        </ul>
      );
    }
  }
};

/** Renders nothing before the first reload or after the result is dismissed. */
export const SectionReloadResult = () => {
  const reload = useSectionReload();
  const at =
    reload.submittedAt === 0 ? null : clockLabel(new Date(reload.submittedAt).toISOString());
  const dismiss = (
    <AlertAction>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss the reload result"
        onClick={() => reload.reset()}
      >
        <XIcon />
      </Button>
    </AlertAction>
  );
  if (reload.isError) {
    const refusal = reloadRefusalOf(reload.error);
    const lead = reloadRefusalLead(
      refusal?.error ??
        (reload.error instanceof OperatorHttpError ? reload.error.error : undefined),
    );
    return (
      <Alert variant="destructive" className="wrap-anywhere">
        <WarningCircleIcon weight="fill" />
        <AlertTitle>
          Configuration not reloaded
          {at !== null && <span className="ml-2 font-mono text-xs tabular-nums">{at}</span>}
        </AlertTitle>
        <AlertDescription className="flex flex-col gap-1">
          {lead !== null && <p className="font-medium text-destructive">{lead}</p>}
          <p>{reload.error.message}</p>
          {refusal !== null && <RefusalSubjects refusal={refusal} />}
        </AlertDescription>
        {dismiss}
      </Alert>
    );
  }
  if (!reload.isSuccess) return null;
  const leftOut = [...reload.data.quarantinedLoops, ...reload.data.invalidAgents];
  return (
    <Alert className="wrap-anywhere">
      <CheckCircleIcon weight="fill" className="text-run-succeeded" />
      <AlertTitle>
        Configuration reloaded
        {at !== null && (
          <span className="ml-2 font-mono text-xs text-muted-foreground tabular-nums">{at}</span>
        )}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-1">
        <ul>
          {reloadChanges(reload.data).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {leftOut.length > 0 && (
          <ul>
            {leftOut.map(({ file, error }) => (
              <li key={file}>
                {fileLink(file)} not loaded: {error.message.replace(/\.$/u, "")}.
              </li>
            ))}
          </ul>
        )}
        <p>Applies to new runs; open runs are unchanged</p>
      </AlertDescription>
      {dismiss}
    </Alert>
  );
};
