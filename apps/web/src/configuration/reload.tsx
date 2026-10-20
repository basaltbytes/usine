import { CheckCircleIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { OperatorHttpError } from "@usine/orchestrator/operator/http";
import { createContext, type ReactNode, use } from "react";
import {
  type ConfigurationReload,
  ReloadConfigurationButton,
  useReloadConfiguration,
} from "@/components/reload-configuration";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { clockLabel, reloadChanges } from "../operator-copy.ts";
import { reloadRefusalLead } from "./copy.ts";

const ReloadContext = createContext<ConfigurationReload | null>(null);

/** Keeps one reload for the whole Configuration section, so its result stays on screen while the
 * operator moves between its pages. */
export const SectionReloadProvider = ({ children }: { readonly children: ReactNode }) => (
  <ReloadContext value={useReloadConfiguration()}>{children}</ReloadContext>
);

const useSectionReload = (): ConfigurationReload => {
  const reload = use(ReloadContext);
  if (reload === null) throw new Error("Configuration pages render inside SectionReloadProvider");
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

/** What the section's last reload changed and which files it left out, or why it was refused and
 * that the running configuration stayed; nothing before the first reload or once dismissed. */
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
    const lead = reloadRefusalLead(
      reload.error instanceof OperatorHttpError ? reload.error.error : undefined,
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
                Left out {fileLink(file)}: {error.message.replace(/\.$/u, "")}.
              </li>
            ))}
          </ul>
        )}
        <p>New Runs use it; open Runs keep the Agent they were opened with.</p>
      </AlertDescription>
      {dismiss}
    </Alert>
  );
};
