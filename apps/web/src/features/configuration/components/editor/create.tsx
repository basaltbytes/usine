import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ConfigurationEntityId, type ConfigurationEntityKind } from "@usine/config/configuration";
import { OperatorHttpError } from "@usine/orchestrator/operator/http";
import { Option, Schema } from "effect";
import { useState } from "react";
import { ErrorAlert } from "~/components/error-alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { entityHref, entityKey, entityTemplate } from "~/features/configuration/lib/entities";
import { entityQuery } from "~/features/configuration/queries";
import { editorCopy } from "~/features/configuration/strings";
import { configurationQuery } from "~/lib/configuration/queries";
import { rejectionMessage } from "~/lib/api";
import { RawEditor } from "./form";

type CreateEntityProps = { readonly kind: ConfigurationEntityKind };

export const CreateEntity = ({ kind }: CreateEntityProps) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const client = useQueryClient();
  const navigate = useNavigate();
  const current = useQuery({ ...entityQuery(entityKey("settings", "instance")), enabled: open });
  const configuration = useQuery(configurationQuery());
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {!open ? (
        <div>
          <Button onClick={() => setOpen(true)}>{editorCopy.new}</Button>
        </div>
      ) : (
        <>
          <h2 className="text-md font-semibold">{editorCopy.create(kind)}</h2>
          {kind === "loop" && <p className="text-muted-foreground">{editorCopy.paused}</p>}
          {editing === null ? (
            <form
              className="flex flex-col items-start gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                const identifier = Schema.decodeUnknownOption(ConfigurationEntityId)(name.trim());
                if (Option.isNone(identifier)) return;
                setChecking(true);
                setError(null);
                void client
                  .fetchQuery(entityQuery(entityKey(kind, identifier.value)))
                  .then(
                    () => setError(editorCopy.alreadyExists),
                    (cause: unknown) => {
                      if (
                        cause instanceof OperatorHttpError &&
                        cause.error === "ConfigurationNotFound"
                      )
                        setEditing(identifier.value);
                      else setError(rejectionMessage(cause));
                    },
                  )
                  .finally(() => setChecking(false));
              }}
            >
              <Label className="flex w-full flex-col items-start gap-2">
                {editorCopy.name}
                <Input required value={name} onChange={(event) => setName(event.target.value)} />
              </Label>
              {error !== null && <ErrorAlert message={error} />}
              {current.isError && <ErrorAlert message={current.error.message} />}
              <div className="flex gap-2">
                <Button
                  type="submit"
                  disabled={checking || current.data === undefined || name.trim() === ""}
                >
                  {checking ? editorCopy.loading : editorCopy.edit}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  {editorCopy.cancel}
                </Button>
              </div>
            </form>
          ) : (
            current.data !== undefined && (
              <RawEditor
                entity={entityKey(kind, editing)}
                initial={{
                  number: current.data.number,
                  text: entityTemplate(
                    kind,
                    editing,
                    configuration.data?.agents[0]?.name ?? "developer",
                  ),
                }}
                cancel={() => {
                  setEditing(null);
                  setOpen(false);
                }}
                onSaved={() => {
                  void navigate({ to: entityHref(entityKey(kind, editing)) });
                }}
              />
            )
          )}
        </>
      )}
    </div>
  );
};
