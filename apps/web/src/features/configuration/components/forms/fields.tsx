import { useId } from "react";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import { Textarea } from "~/components/ui/textarea";
import {
  fieldValue,
  stringValue,
  withField,
  type FormFieldsProps,
} from "~/features/configuration/lib/forms";
import { formCopy } from "~/features/configuration/strings";

export type FieldDefinition = {
  readonly path: string;
  readonly label: string;
  readonly description?: string;
  readonly kind?: "number" | "textarea";
  readonly options?: readonly string[];
  readonly labeledOptions?: readonly { readonly value: string; readonly label: string }[];
  readonly suggestions?: readonly string[];
  readonly readOnly?: boolean;
  readonly optional?: boolean;
};
type FormFieldProps = FormFieldsProps & FieldDefinition;
export const FormField = ({
  value,
  onChange,
  problems,
  path,
  label,
  description,
  kind,
  options,
  labeledOptions,
  suggestions,
  readOnly,
  optional,
}: FormFieldProps) => {
  const id = useId();
  const choices = labeledOptions ?? options?.map((value) => ({ value, label: value }));
  const errors = problems.filter((problem) => problem.path.join(".") === path);
  const props = {
    id,
    value: stringValue(fieldValue(value, path)),
    readOnly,
    autoComplete: "off",
    spellCheck: false,
    "aria-invalid": errors.length > 0,
    "aria-describedby": `${id}-help`,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
    ) => {
      const text = event.target.value;
      const next =
        optional === true && text === ""
          ? undefined
          : kind === "number"
            ? text === ""
              ? undefined
              : Number(text)
            : text;
      onChange(withField(value, path, next));
    },
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {choices !== undefined ? (
        <NativeSelect {...props} className="w-full" disabled={readOnly}>
          <option value="">{formCopy.choose}</option>
          {choices.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
      ) : kind === "textarea" ? (
        <Textarea {...props} className="min-h-36 min-w-0 [field-sizing:fixed]" />
      ) : (
        <Input
          {...props}
          type={kind === "number" ? "number" : "text"}
          step="any"
          list={suggestions === undefined ? undefined : `${id}-options`}
        />
      )}
      {suggestions !== undefined && (
        <datalist id={`${id}-options`}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      )}
      <div id={`${id}-help`} className="space-y-1 text-xs wrap-anywhere">
        {description && <p className="text-muted-foreground">{description}</p>}
        {errors.map((error, index) => (
          <p role="alert" key={index} className="text-destructive">
            {error.message}
          </p>
        ))}
      </div>
    </div>
  );
};

type FieldsProps = FormFieldsProps & { readonly definitions: readonly FieldDefinition[] };
export const Fields = ({ definitions, ...fields }: FieldsProps) => (
  <div className="grid min-w-0 gap-x-8 gap-y-5 sm:grid-cols-2">
    {definitions.map((definition) => (
      <FormField key={definition.path} {...fields} {...definition} />
    ))}
  </div>
);
