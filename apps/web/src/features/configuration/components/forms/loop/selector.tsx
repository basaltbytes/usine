import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import {
  arrayValue,
  objectValue,
  stringValue,
  type FormFieldsProps,
} from "~/features/configuration/lib/forms";
import { loopFormCopy } from "~/features/configuration/strings";

type SelectorFieldsProps = FormFieldsProps & {
  readonly repositories: readonly string[];
  readonly tags: readonly string[];
};
export const SelectorFields = ({
  value,
  onChange,
  problems,
  repositories,
  tags,
}: SelectorFieldsProps) => {
  const selector = objectValue(objectValue(value.selector).value);
  const selected = (key: string) => arrayValue(selector[key]).map(stringValue);
  const toggle = (key: string, choice: string, checked: boolean) => {
    const next = checked
      ? [...selected(key), choice]
      : selected(key).filter((entry) => entry !== choice);
    const fields = { ...selector };
    if (next.length === 0) delete fields[key];
    else fields[key] = next;
    onChange({
      ...value,
      selector:
        Object.keys(fields).length === 0 ? { _tag: "None" } : { _tag: "Some", value: fields },
    });
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{loopFormCopy.allRepositories}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {[
          { key: "repos", label: loopFormCopy.repositories, choices: repositories },
          { key: "tags", label: loopFormCopy.tags, choices: tags },
        ].map(({ key, label, choices }) => (
          <fieldset className="space-y-2" key={key}>
            <legend className="mb-2 font-medium">{label}</legend>
            {choices.map((choice) => (
              <Label key={choice} className="flex items-center gap-2">
                <Checkbox
                  checked={selected(key).includes(choice)}
                  onCheckedChange={(checked) => toggle(key, choice, checked)}
                />
                {choice}
              </Label>
            ))}
          </fieldset>
        ))}
      </div>
      {problems
        .filter((problem) => problem.path[0] === "selector")
        .map((problem, index) => (
          <p key={index} role="alert" className="text-destructive">
            {problem.message}
          </p>
        ))}
    </div>
  );
};
