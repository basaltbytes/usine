import type { ConfigurationEntityView } from "@usine/orchestrator/operator/http";
import { useQuery } from "@tanstack/react-query";
import type { ConfigurationEntityKey } from "@usine/config/configuration";
import { useState, type ReactNode } from "react";
import { ErrorAlert } from "~/components/error-alert";
import { CommandButton } from "~/components/command-palette/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { entityReferences } from "~/features/configuration/lib/entities";
import { entityQuery, useConfigurationWrite } from "~/features/configuration/queries";
import { editorCopy } from "~/features/configuration/strings";
import { configurationQuery } from "~/lib/configuration/queries";
import { ConfigurationEditorForm } from "./form";
import { WriteFailure } from "./failure";
import { ConfigurationHistory } from "./history";

type EntityMode =
  | { readonly _tag: "read" }
  | { readonly _tag: "edit"; readonly initial: ConfigurationEntityView }
  | { readonly _tag: "delete"; readonly initial: ConfigurationEntityView };

type EntityEditorProps = { readonly entity: ConfigurationEntityKey; readonly children: ReactNode };

export const EntityEditor = ({ entity, children }: EntityEditorProps) => {
  const current = useQuery(entityQuery(entity));
  const configuration = useQuery(configurationQuery());
  const [mode, setMode] = useState<EntityMode>({ _tag: "read" });
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);
  const write = useConfigurationWrite();
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <CommandButton
          command={editorCopy.edit}
          variant="outline"
          disabled={current.data === undefined || current.isError || mode._tag !== "read"}
          onClick={() => {
            setSaved(false);
            if (current.data !== undefined) setMode({ _tag: "edit", initial: current.data });
          }}
        >
          {editorCopy.edit}
        </CommandButton>
        <CommandButton
          command={editorCopy.delete}
          variant="ghost"
          disabled={current.data === undefined || current.isError || mode._tag !== "read"}
          onClick={() => {
            write.reset();
            if (current.data !== undefined) setMode({ _tag: "delete", initial: current.data });
          }}
        >
          {editorCopy.delete}
        </CommandButton>
        {current.isPending && <span role="status">{editorCopy.loading}</span>}
        {saved && <span role="status">{editorCopy.saved}</span>}
        {write.isSuccess && current.isError && <span role="status">{editorCopy.deleted}</span>}
      </div>
      {current.isError && !write.isSuccess && <ErrorAlert message={current.error.message} />}
      {mode._tag === "edit" && (
        <ConfigurationEditorForm
          entity={entity}
          initial={mode.initial}
          onSaved={() => {
            setMode({ _tag: "read" });
            setSaved(true);
          }}
          cancel={() => setMode({ _tag: "read" })}
        />
      )}
      {mode._tag === "delete" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (write.isPending) return;
            write.mutate(
              {
                action: "delete",
                key: entity,
                payload: { expected: mode.initial.number, message },
              },
              { onSuccess: () => setMode({ _tag: "read" }) },
            );
          }}
        >
          <h2 className="text-md font-semibold">{editorCopy.deleteWarning(entity.identifier)}</h2>
          {configuration.data !== undefined && (
            <p className="wrap-anywhere">
              {editorCopy.references(entityReferences(entity, configuration.data))}
            </p>
          )}
          <Label className="flex flex-col items-start gap-2">
            {editorCopy.message}
            <Input value={message} onChange={(event) => setMessage(event.target.value)} />
          </Label>
          {write.isError && <WriteFailure error={write.error} />}
          <div className="flex gap-2">
            <CommandButton
              command={editorCopy.confirmDelete}
              type="submit"
              variant="destructive"
              disabled={write.isPending || configuration.data === undefined}
            >
              {write.isPending ? editorCopy.saving : editorCopy.confirmDelete}
            </CommandButton>
            <CommandButton
              command={editorCopy.cancel}
              type="button"
              variant="ghost"
              disabled={write.isPending}
              onClick={() => setMode({ _tag: "read" })}
            >
              {editorCopy.cancel}
            </CommandButton>
          </div>
        </form>
      )}
      {mode._tag === "read" && children}
      <ConfigurationHistory entity={entity} />
    </div>
  );
};
