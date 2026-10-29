import { useId, useState } from "react";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  arrayValue,
  fieldValue,
  stringValue,
  withField,
  type FormFieldsProps,
} from "~/features/configuration/lib/forms";

type ListFieldProps = FormFieldsProps & { readonly path: string; readonly label: string };
export const ListField = ({ value, onChange, problems, path, label }: ListFieldProps) => {
  const id = useId();
  const [text, setText] = useState(() =>
    arrayValue(fieldValue(value, path)).map(stringValue).join(", "),
  );
  const errors = problems.filter((problem) => problem.path.join(".").startsWith(path));
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={text}
        aria-invalid={errors.length > 0}
        aria-describedby={`${id}-errors`}
        onChange={(event) => {
          setText(event.target.value);
          onChange(
            withField(
              value,
              path,
              event.target.value
                .split(",")
                .map((part) => part.trim())
                .filter(Boolean),
            ),
          );
        }}
      />
      <div id={`${id}-errors`}>
        {errors.map((problem, index) => (
          <p key={index} role="alert" className="text-destructive">
            {problem.message}
          </p>
        ))}
      </div>
    </div>
  );
};
