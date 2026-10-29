import type { RepositoryName } from "@usine/core/repository";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import { repositoryFilterLabel, allRepositoriesLabel } from "~/lib/strings";

type RepositoryFilterProps = {
  readonly repositories: readonly RepositoryName[];
  readonly value: RepositoryName | undefined;
  readonly onChange: (repository: RepositoryName | undefined) => void;
};

export const RepositoryFilter = ({ repositories, value, onChange }: RepositoryFilterProps) => (
  <Label className="flex min-w-0 flex-wrap items-center gap-2">
    {repositoryFilterLabel}
    <NativeSelect
      className="w-full min-w-0 sm:w-auto"
      value={value ?? ""}
      onChange={(event) =>
        onChange(repositories.find((repository) => repository === event.target.value))
      }
    >
      <option value="">{allRepositoriesLabel}</option>
      {repositories.map((repository) => (
        <option key={repository} value={repository}>
          {repository}
        </option>
      ))}
    </NativeSelect>
  </Label>
);
