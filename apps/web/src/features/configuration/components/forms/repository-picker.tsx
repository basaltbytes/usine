import { useQuery } from "@tanstack/react-query";
import { ErrorAlert } from "~/components/error-alert";
import { NativeSelect } from "~/components/ui/native-select";
import { Label } from "~/components/ui/label";
import { installationRepositoriesQuery } from "~/features/configuration/queries";
import { formCopy } from "~/features/configuration/strings";
import { configurationQuery } from "~/lib/configuration/queries";

type RepositoryPickerProps = {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
};
export const RepositoryPicker = ({ value, onChange, disabled }: RepositoryPickerProps) => {
  const installation = useQuery(installationRepositoriesQuery());
  const configuration = useQuery(configurationQuery());
  const registered = new Set(
    configuration.data?.repositories.map(({ name }) => name.toLowerCase()),
  );
  const repositories =
    installation.data?.filter((name) => !registered.has(name.toLowerCase())) ?? [];
  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <Label className="flex flex-col items-start gap-2">
        {formCopy.repositories}
        <NativeSelect
          className="w-full"
          value={value}
          disabled={disabled || installation.isPending || configuration.data === undefined}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{formCopy.choose}</option>
          {repositories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </NativeSelect>
      </Label>
      {installation.isPending && <p role="status">{formCopy.loading}</p>}
      {installation.isError && <ErrorAlert message={installation.error.message} />}
      {configuration.isError && <ErrorAlert message={configuration.error.message} />}
      {installation.isSuccess && configuration.isSuccess && repositories.length === 0 && (
        <p>{formCopy.noRepositories}</p>
      )}
    </div>
  );
};
