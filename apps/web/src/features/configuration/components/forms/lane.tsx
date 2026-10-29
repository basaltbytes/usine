import { GitHubLabelName } from "@usine/config/label";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DotsSixVerticalIcon, ArrowUpIcon, ArrowDownIcon } from "@phosphor-icons/react";
import { LaneItemState } from "@usine/config/board";
import type { RepositoryLabel } from "@usine/github/polling";
import { Option } from "effect";
import { LabelBadge } from "~/components/label-badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { type FormFieldsProps, arrayValue, objectValue } from "~/features/configuration/lib/forms";
import { formCopy } from "~/features/configuration/strings";
import { FormField } from "./fields";

type LaneFieldsProps = FormFieldsProps & {
  readonly id: number;
  readonly index: number;
  readonly count: number;
  readonly labels: readonly RepositoryLabel[];
  readonly remove: () => void;
  readonly move: (delta: number) => void;
};
export const LaneFields = ({
  id,
  index,
  count,
  labels,
  remove,
  move,
  ...fields
}: LaneFieldsProps) => {
  const sortable = useSortable({ id });
  const sources = arrayValue(fields.value.sources).map(objectValue);
  const toggle = (kind: "label" | "state", name: string, checked: boolean) =>
    fields.onChange({
      ...fields.value,
      sources: checked
        ? [...sources, { [kind]: name }]
        : sources.filter((source) => source[kind] !== name),
    });
  const missing = sources.flatMap((source) =>
    "label" in source && !labels.some((label) => label.name === source.label)
      ? [String(source.label)]
      : [],
  );
  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className="min-w-0 space-y-4 border-b py-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={sortable.setActivatorNodeRef}
          {...sortable.attributes}
          {...sortable.listeners}
          type="button"
          variant="ghost"
          className="touch-none"
          aria-label={`${formCopy.reorder} ${index + 1}`}
        >
          <DotsSixVerticalIcon />
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">{index + 1}</span>
        <Button
          type="button"
          variant="ghost"
          aria-label={`${formCopy.moveUp} ${index + 1}`}
          disabled={index === 0}
          onClick={() => move(-1)}
        >
          <ArrowUpIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          aria-label={`${formCopy.moveDown} ${index + 1}`}
          disabled={index === count - 1}
          onClick={() => move(1)}
        >
          <ArrowDownIcon />
        </Button>
        <Button type="button" variant="ghost" className="ml-auto" onClick={remove}>
          {formCopy.removeLane}
        </Button>
      </div>
      <FormField {...fields} path="name" label={formCopy.laneName} />
      <fieldset className="min-w-0">
        <legend className="mb-2 font-medium">{formCopy.labels}</legend>
        <div className="flex flex-wrap gap-3">
          {labels.map((label) => (
            <Label key={label.name} className="min-w-0">
              <Checkbox
                checked={sources.some((source) => source.label === label.name)}
                onCheckedChange={(checked) => toggle("label", label.name, checked === true)}
              />
              <LabelBadge
                name={label.name}
                label={{
                  name: GitHubLabelName.make(label.name),
                  color: label.color,
                  description: Option.getOrNull(label.description),
                }}
                className="max-w-full whitespace-normal wrap-anywhere"
              />
            </Label>
          ))}
          {missing.map((name) => (
            <Label key={name}>
              <Checkbox checked onCheckedChange={() => toggle("label", name, false)} />
              <LabelBadge name={name} label={undefined} />
            </Label>
          ))}
        </div>
        {labels.length === 0 && <p className="text-muted-foreground">{formCopy.noLabels}</p>}
      </fieldset>
      <fieldset>
        <legend className="mb-2 font-medium">{formCopy.states}</legend>
        <div className="flex flex-wrap gap-3">
          {LaneItemState.literals.map((state) => (
            <Label key={state}>
              <Checkbox
                checked={sources.some((source) => source.state === state)}
                onCheckedChange={(checked) => toggle("state", state, checked === true)}
              />
              {state}
            </Label>
          ))}
        </div>
      </fieldset>
      {fields.problems
        .filter((problem) => problem.path[0] === "sources")
        .map((problem, index) => (
          <p key={index} role="alert" className="text-destructive">
            {problem.message}
          </p>
        ))}
    </div>
  );
};
