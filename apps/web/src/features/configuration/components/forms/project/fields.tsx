import { useQuery } from "@tanstack/react-query";
import { RepositoryName, canonicalRepositoryName } from "@usine/core/repository";
import { Schema } from "effect";
import { ArrowUpIcon, ArrowDownIcon, XIcon } from "@phosphor-icons/react";
import { arrayMove } from "@dnd-kit/sortable";
import { ErrorAlert } from "~/components/error-alert";
import { RepositoryMark } from "~/components/repository-mark";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import { FormField } from "~/features/configuration/components/forms/fields";
import { arrayValue, stringValue, type FormFieldsProps } from "~/features/configuration/lib/forms";
import { projectCopy } from "~/features/configuration/strings";
import { configurationQuery } from "~/lib/configuration/queries";
import { ProjectLanes } from "./lanes";

export const ProjectFields = (fields: FormFieldsProps) => {
  const configuration = useQuery(configurationQuery());
  const repositories = arrayValue(fields.value.repositories).filter(Schema.is(RepositoryName));
  const assigned = new Set(
    configuration.data?.projects
      .filter((project) => project.id !== stringValue(fields.value.id))
      .flatMap((project) => project.repositories.map(canonicalRepositoryName)),
  );
  const choices =
    configuration.data?.repositories.filter(
      ({ name }) =>
        !assigned.has(canonicalRepositoryName(name)) &&
        !repositories.some(
          (selected) => canonicalRepositoryName(selected) === canonicalRepositoryName(name),
        ),
    ) ?? [];
  const change = (repositories: readonly RepositoryName[]) =>
    fields.onChange({ ...fields.value, repositories });
  return (
    <div className="min-w-0 space-y-5">
      <FormField {...fields} path="id" label={projectCopy.id} readOnly />
      <FormField {...fields} path="name" label={projectCopy.name} />
      {configuration.isError && <ErrorAlert message={configuration.error.message} />}
      <fieldset className="min-w-0 space-y-3">
        <legend className="mb-2 font-medium">{projectCopy.repositories}</legend>
        <ol className="space-y-2">
          {repositories.map((repository, index) => (
            <li key={repository} className="flex min-w-0 items-center gap-2">
              <RepositoryMark repository={repository} />
              <span className="min-w-0 flex-1 truncate" title={repository}>
                {repository}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`${projectCopy.up}: ${repository}`}
                disabled={index === 0}
                onClick={() => change(arrayMove(repositories, index, index - 1))}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`${projectCopy.down}: ${repository}`}
                disabled={index === repositories.length - 1}
                onClick={() => change(arrayMove(repositories, index, index + 1))}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`${projectCopy.remove}: ${repository}`}
                onClick={() => change(repositories.filter((_, position) => position !== index))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ol>
        <Label className="flex min-w-0 flex-col items-start gap-2">
          {projectCopy.choose}
          <NativeSelect
            className="w-full"
            value=""
            disabled={configuration.isPending || choices.length === 0}
            onChange={(event) => {
              const selected = choices.find(({ name }) => name === event.target.value);
              if (selected !== undefined) change([...repositories, selected.name]);
            }}
          >
            <option value="">
              {choices.length === 0 ? projectCopy.unassigned : projectCopy.choose}
            </option>
            {choices.map(({ name }) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </NativeSelect>
        </Label>
      </fieldset>
      <p className="text-xs text-muted-foreground">{projectCopy.lanesHint}</p>
      <ProjectLanes {...fields} repositories={repositories} />
    </div>
  );
};
