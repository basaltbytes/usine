import { permits, ProjectScope } from "@usine/core/access";
import { useCan, usePermissions } from "~/lib/permissions";
import { ProjectId } from "@usine/core/project";
import { NativeSelect } from "~/components/ui/native-select";
import { projectCopy } from "~/features/configuration/strings";
import { RepositoryPicker } from "~/features/configuration/components/forms/repository-picker";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ConfigurationEntityId, type ConfigurationEntityKind } from "@usine/config/configuration";
import { OperatorHttpError } from "@usine/orchestrator/operator/http";
import { Option, Schema } from "effect";
import { createContext, useContext, useId, useState } from "react";
import { ErrorAlert } from "~/components/error-alert";
import { CommandButton } from "~/components/command-palette/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { entityHref, entityKey, entityTemplate } from "~/features/configuration/lib/entities";
import { entityQuery, configurationHeadQuery } from "~/features/configuration/queries";
import { editorCopy } from "~/features/configuration/strings";
import { membersQuery } from "~/lib/members/queries";
import { configurationQuery } from "~/lib/configuration/queries";
import { rejectionMessage } from "~/lib/api";
import { ConfigurationEditorForm } from "./form";

type CreationFormProps = {
  readonly kind: ConfigurationEntityKind;
  readonly initialMember?: string | undefined;
  readonly cancel: () => void;
};

export const CreationForm = ({ kind, initialMember, cancel }: CreationFormProps) => {
  const members = useQuery({ ...membersQuery(), enabled: kind === "binding" });
  const selectedMember = members.data?.find(({ login }) => login === initialMember);
  const grants = usePermissions();
  const [project, setProject] = useState("");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const client = useQueryClient();
  const navigate = useNavigate();
  const headingId = useId();
  const current = useQuery(configurationHeadQuery());
  const configuration = useQuery(configurationQuery());
  let bindingDraft: Schema.JsonObject = { name: editing ?? "", role: "viewer" };
  if (selectedMember !== undefined) bindingDraft = { ...bindingDraft, member: selectedMember.id };
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-4 border-b pb-6 last:border-b-0 last:pb-0"
    >
      <header className="flex flex-col gap-1">
        <h2 id={headingId} className="text-md font-semibold">
          {editorCopy.create(kind)}
        </h2>
        {kind === "loop" && <p className="text-muted-foreground">{editorCopy.paused}</p>}
      </header>
      {editing === null ? (
        <form
          className="flex max-w-3xl flex-col items-start gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const identifier: Option.Option<ProjectId | ConfigurationEntityId> =
              kind === "project"
                ? Schema.decodeOption(ProjectId)(name.trim())
                : Schema.decodeOption(ConfigurationEntityId)(
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
                  if (
                    Schema.is(OperatorHttpError)(cause) &&
                    cause.error === "ConfigurationNotFound"
                  )
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
                {configuration.data?.projects
                  .filter(({ id }) =>
                    permits(grants, "maintain", ProjectScope.make({ project: id })),
                  )
                  .map((project) => (
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
            <CommandButton
              command={editorCopy.continue}
              type="submit"
              disabled={
                checking ||
                current.data === undefined ||
                name.trim() === "" ||
                (kind === "loop" && project === "")
              }
            >
              {checking ? editorCopy.loading : editorCopy.continue}
            </CommandButton>
            <CommandButton
              command={editorCopy.cancel}
              type="button"
              variant="ghost"
              onClick={cancel}
            >
              {editorCopy.cancel}
            </CommandButton>
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
            initialValue={kind === "binding" ? bindingDraft : undefined}
            cancel={cancel}
            onSaved={() => {
              void navigate({ to: entityHref(entityKey(kind, editing)) });
            }}
          />
        )
      )}
    </section>
  );
};

type Creation = {
  readonly kind: ConfigurationEntityKind;
  readonly creating: boolean;
  readonly start: () => void;
};

export const CreationContext = createContext<Creation | null>(null);

type NewEntityButtonProps = { readonly className?: string };

/** Renders the button that opens the creation form of the page's `CreationContext`. */
export const NewEntityButton = ({ className }: NewEntityButtonProps) => {
  const creation = useContext(CreationContext);
  const admin = useCan("admin");
  const grants = usePermissions();
  if (creation === null) return null;
  const allowed =
    admin ||
    (creation.kind === "loop" && grants.some(({ permission }) => permission === "maintain"));
  if (!allowed) return null;
  const label = editorCopy.create(creation.kind);
  return (
    <CommandButton
      command={label}
      className={className}
      disabled={creation.creating}
      onClick={creation.start}
    >
      {label}
    </CommandButton>
  );
};
