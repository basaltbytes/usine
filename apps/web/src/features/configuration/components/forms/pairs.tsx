import { useState } from "react";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import {
  type FormFieldsProps,
  fieldValue,
  objectValue,
  withField,
} from "~/features/configuration/lib/forms";
import { formCopy } from "~/features/configuration/strings";
import { FormField } from "./fields";

type PairsProps = FormFieldsProps & { readonly path: string; readonly label: string };
export const Pairs = ({ path, label, value, onChange, problems }: PairsProps) => {
  const [key, setKey] = useState("");
  const pairs = objectValue(fieldValue(value, path));
  const prefix = path.split(".");
  const errors = problems.filter((problem) =>
    prefix.every((part, index) => problem.path[index] === part),
  );
  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="mb-2 font-medium">{label}</legend>
      {Object.entries(pairs).map(([name, entry]) => (
        <div key={name} className="flex min-w-0 items-end gap-2">
          <div className="min-w-0 flex-1">
            <FormField
              path="value"
              label={name}
              value={{ value: entry }}
              problems={errors
                .filter((problem) => problem.path[prefix.length] === name)
                .map((problem) => ({ ...problem, path: ["value"] }))}
              onChange={(next) =>
                onChange(withField(value, path, { ...pairs, [name]: next.value ?? "" }))
              }
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              const next = { ...pairs };
              delete next[name];
              onChange(withField(value, path, next));
            }}
          >
            {formCopy.remove}
          </Button>
        </div>
      ))}
      {errors
        .filter((problem) => problem.path.length === prefix.length)
        .map((problem, index) => (
          <p key={index} role="alert" className="text-destructive wrap-anywhere">
            {problem.message}
          </p>
        ))}
      <div className="flex min-w-0 items-end gap-2">
        <Label className="min-w-0 flex-1 flex-col items-start gap-2">
          {formCopy.key}
          <Input value={key} onChange={(event) => setKey(event.target.value)} />
        </Label>
        <Button
          type="button"
          variant="outline"
          disabled={key.trim() === "" || key in pairs}
          onClick={() => {
            onChange(withField(value, path, { ...pairs, [key]: "" }));
            setKey("");
          }}
        >
          {formCopy.add}
        </Button>
      </div>
    </fieldset>
  );
};
