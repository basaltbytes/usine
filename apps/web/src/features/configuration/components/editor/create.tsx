import { ProjectId } from "@usine/core/project";
import { NativeSelect } from "~/components/ui/native-select";
import { projectCopy } from "~/features/configuration/strings";
import { RepositoryPicker } from "~/features/configuration/components/forms/repository-picker";
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
import { ConfigurationEditorForm } from "./form";

type CreateEntityProps = { readonly kind: ConfigurationEntityKind };

type CreationFormProps = CreateEntityProps & { readonly cancel: () => void };

const CreationForm = ({ kind, cancel }: CreationFormProps) => {
  const [project, setProject] = useState("");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const client = useQueryClient();
  const navigate = useNavigate();
  const current = useQuery(entityQuery(entityKey("settings", "instance")));
  const configuration = useQuery(configurationQuery());
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h2 className="text-md font-semibold">{editorCopy.create(kind)}</h2>
      {kind === "loop" && <p className="text-muted-foreground">{editorCopy.paused}</p>}
      {editing === null ? (
        <form
          className="flex flex-col items-start gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const identifier: Option.Option<ProjectId | ConfigurationEntityId> =
              kind === "project"
                ? Schema.decodeUnknownOption(ProjectId)(name.trim())
                : Schema.decodeUnknownOption(ConfigurationEntityId)(
                    kind === "loop" ? `${project}/${name.trim()}` : name.trim(),
                  );
            if (Option.isNone(identifier)) {
              if (kind === "project") setError(projectCopy.invalidId);
              return;
            }
            setChecking(true);
            setError(null);
            void client
              .fetchQuery(entityQuery(entityKey(kind, identifier.value)))
              .then(
                () => setError(editorCopy.alreadyExists),
                (cause: unknown) => {
                  if (cause instanceof OperatorHttpError && cause.error === "ConfigurationNotFound")
                    setEditing(identifier.value);
                  else setError(rejectionMessage(cause));
                },
              )
              .finally(() => setChecking(false));
          }}
        >
          {kind === "loop" && (
            <Label className="flex w-full flex-col items-start gap-2">
              {projectCopy.project}
              <NativeSelect
                className="w-full"
                value={project}
                required
                disabled={checking}
                onChange={(event) => setProject(event.target.value)}
              >
                <option value="">{projectCopy.chooseProject}</option>
                {configuration.data?.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </NativeSelect>
            </Label>
          )}
          {kind === "repository" ? (
            <RepositoryPicker value={name} onChange={setName} disabled={checking} />
          ) : (
            <Label className="flex w-full flex-col items-start gap-2">
              {kind === "project" ? projectCopy.id : editorCopy.name}
              <Input
                required
                disabled={checking || (kind === "loop" && project === "")}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Label>
          )}
          {error !== null && <ErrorAlert message={error} />}
          {current.isError && <ErrorAlert message={current.error.message} />}
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={
                checking ||
                current.data === undefined ||
                name.trim() === "" ||
                (kind === "loop" && project === "")
              }
            >
              {checking ? editorCopy.loading : editorCopy.edit}
            </Button>
            <Button type="button" variant="ghost" onClick={cancel}>
              {editorCopy.cancel}
            </Button>
          </div>
        </form>
      ) : (
        current.data !== undefined && (
          <ConfigurationEditorForm
            entity={entityKey(kind, editing)}
            initial={{
              number: current.data.number,
              text: entityTemplate(
                kind,
                editing,
                configuration.data?.agents[0]?.name ?? "developer",
              ),
            }}
            cancel={cancel}
            onSaved={() => {
              void navigate({ to: entityHref(entityKey(kind, editing)) });
            }}
          />
        )
      )}
    </div>
  );
};

export const CreateEntity = ({ kind }: CreateEntityProps) => {
  const [open, setOpen] = useState(false);
  return open ? (
    <CreationForm kind={kind} cancel={() => setOpen(false)} />
  ) : (
    <div>
      <Button onClick={() => setOpen(true)}>{editorCopy.new}</Button>
    </div>
  );
};
