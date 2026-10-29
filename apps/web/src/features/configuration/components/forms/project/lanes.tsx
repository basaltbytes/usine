import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { RepositoryName } from "@usine/core/repository";
import { Button } from "~/components/ui/button";
import { ErrorAlert } from "~/components/error-alert";
import { type FormFieldsProps, arrayValue, objectValue } from "~/features/configuration/lib/forms";
import { repositoryLabelsQuery } from "~/features/configuration/queries";
import { formCopy } from "~/features/configuration/strings";
import { LaneFields } from "~/features/configuration/components/forms/lane";

type ProjectLanesProps = FormFieldsProps & { readonly repositories: readonly RepositoryName[] };
export const ProjectLanes = ({ repositories, ...fields }: ProjectLanesProps) => {
  const lookups = useQueries({ queries: repositories.map(repositoryLabelsQuery) });
  const labels = [
    ...new Map(
      lookups
        .flatMap((lookup) => lookup.data ?? [])
        .map((label) => [label.name.toLowerCase(), label]),
    ).values(),
  ];
  const lanes = arrayValue(fields.value.lanes).map(objectValue);
  const [ids, setIds] = useState(() => lanes.map((_, index) => index));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const reorder = (from: number, to: number) => {
    if (from < 0 || to < 0 || from === to) return;
    setIds(arrayMove(ids, from, to));
    fields.onChange({ ...fields.value, lanes: arrayMove(lanes, from, to) });
  };
  return (
    <div className="min-w-0 space-y-5">
      <div>
        <h2 className="text-md font-semibold">{formCopy.lanes}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{formCopy.orderHint}</p>
      </div>
      {lookups.some((lookup) => lookup.isPending) && <p role="status">{formCopy.loading}</p>}
      {lookups.map(
        (lookup, index) =>
          lookup.isError && <ErrorAlert key={repositories[index]} message={lookup.error.message} />,
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={({ active, over }) => {
          if (over !== null)
            reorder(
              ids.findIndex((id) => id === active.id),
              ids.findIndex((id) => id === over.id),
            );
        }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {lanes.map((lane, index) => (
            <LaneFields
              key={ids[index]}
              id={ids[index] ?? index}
              index={index}
              count={lanes.length}
              value={lane}
              labels={labels}
              problems={fields.problems
                .filter((problem) => problem.path[0] === "lanes" && problem.path[1] === index)
                .map((problem) => ({ ...problem, path: problem.path.slice(2) }))}
              onChange={(next) =>
                fields.onChange({
                  ...fields.value,
                  lanes: lanes.map((current, position) => (position === index ? next : current)),
                })
              }
              remove={() => {
                setIds(ids.filter((_, position) => position !== index));
                fields.onChange({
                  ...fields.value,
                  lanes: lanes.filter((_, position) => position !== index),
                });
              }}
              move={(delta) => reorder(index, index + delta)}
            />
          ))}
        </SortableContext>
      </DndContext>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          setIds([...ids, Math.max(-1, ...ids) + 1]);
          fields.onChange({ ...fields.value, lanes: [...lanes, { name: "", sources: [] }] });
        }}
      >
        {formCopy.addLane}
      </Button>
    </div>
  );
};
