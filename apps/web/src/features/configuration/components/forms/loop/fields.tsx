import { Stream } from "@usine/config/trigger";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { LOOP_PERMISSIONS, LoopName } from "@usine/core/loop";
import { ErrorAlert } from "~/components/error-alert";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import { PromptMarkdown } from "~/features/configuration/components/prompt";
import { objectValue, stringValue, type FormFieldsProps } from "~/features/configuration/lib/forms";
import { loopCheckQuery } from "~/features/configuration/queries";
import { loopFormCopy, projectCopy } from "~/features/configuration/strings";
import { configurationQuery } from "~/lib/configuration/queries";
import { Fields } from "~/features/configuration/components/forms/fields";
import { ExpressionField } from "./expression";
import { SelectorFields } from "./selector";
import { LoopPreview } from "./preview";

type LoopFieldsProps = FormFieldsProps & { readonly name: string };
export const LoopFields = ({ name, ...fields }: LoopFieldsProps) => {
  const approvalId = useId();
  const approval = stringValue(fields.value.approval);
  const conditionalApproval = approval !== "none" && approval !== "required";
  const configuration = useQuery(configurationQuery());
  const project = configuration.data?.projects.find((project) => name.startsWith(`${project.id}/`));
  const repositories =
    configuration.data?.repositories.filter((repository) => project?.includes(repository.name)) ??
    [];
  const [checkedValue, setCheckedValue] = useState(fields.value);
  const [preview, setPreview] = useState<typeof fields.value>();
  useEffect(() => {
    const timer = setTimeout(() => setCheckedValue(fields.value), 350);
    return () => clearTimeout(timer);
  }, [fields.value]);
  const check = useQuery(loopCheckQuery({ name: LoopName.make(name), value: checkedValue }));
  const checking = checkedValue !== fields.value || check.isFetching;
  const problems = [...fields.problems, ...(checking ? [] : (check.data?.problems ?? []))];
  const props = { ...fields, problems };
  const trigger = objectValue(fields.value.trigger);
  const stream = trigger.on === "pr" ? "pr" : trigger.on === "schedule" ? "schedule" : "issue";
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {configuration.isError && <ErrorAlert message={configuration.error.message} />}
      <p>
        <span className="text-muted-foreground">{projectCopy.project}: </span>
        {project?.name ?? name.split("/")[0]}
      </p>
      <Fields
        {...props}
        onChange={(value) => {
          const next = objectValue(value.trigger);
          if (next.on !== stream) {
            const { cron: _cron, tz: _tz, ...trigger } = next;
            fields.onChange({
              ...value,
              trigger:
                next.on === "schedule" ? { ...trigger, cron: "0 9 * * *", tz: "UTC" } : trigger,
            });
          } else fields.onChange(value);
        }}
        definitions={[
          { path: "trigger.on", label: loopFormCopy.stream, options: Stream.literals },
          ...(stream === "schedule"
            ? [
                { path: "trigger.cron", label: loopFormCopy.cron },
                { path: "trigger.tz", label: loopFormCopy.timeZone },
              ]
            : []),
        ]}
      />
      <ExpressionField
        {...props}
        path="trigger.if"
        label={loopFormCopy.condition}
        stream={stream}
      />
      <ExpressionField
        {...props}
        value={{
          ...fields.value,
          priority: String(objectValue(fields.value.priority).value ?? ""),
        }}
        onChange={(value) => {
          const text = stringValue(value.priority);
          fields.onChange({
            ...fields.value,
            priority: text.trim() === "" ? { _tag: "None" } : { _tag: "Some", value: text },
          });
        }}
        problems={problems.map((problem) =>
          problem.path[0] === "priority" ? { ...problem, path: ["priority"] } : problem,
        )}
        path="priority"
        label={loopFormCopy.priority}
        stream={stream}
      />
      <p className="text-xs text-muted-foreground">{loopFormCopy.priorityHint}</p>
      <SelectorFields
        {...props}
        repositories={repositories.map(({ name }) => name)}
        tags={[...new Set(repositories.flatMap(({ tags }) => tags))]}
      />
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor={approvalId}>{loopFormCopy.approval}</Label>
        <NativeSelect
          id={approvalId}
          value={conditionalApproval ? "condition" : approval}
          onChange={(event) =>
            fields.onChange({
              ...fields.value,
              approval: event.target.value === "condition" ? "true" : event.target.value,
            })
          }
        >
          <option value="none">{loopFormCopy.approvalNone}</option>
          <option value="required">{loopFormCopy.approvalRequired}</option>
          <option value="condition">{loopFormCopy.approvalConditional}</option>
        </NativeSelect>
      </div>
      {conditionalApproval && (
        <ExpressionField
          {...props}
          path="approval"
          label={loopFormCopy.approvalCondition}
          stream={stream}
        />
      )}
      <p className="text-xs text-muted-foreground">{loopFormCopy.approvalHint}</p>
      <Fields
        {...props}
        definitions={[
          { path: "step", label: loopFormCopy.step },
          {
            path: "agent",
            label: loopFormCopy.agent,
            options: configuration.data?.agents.map(({ name }) => name) ?? [],
          },
          { path: "maxCycles", label: loopFormCopy.cycles, kind: "number" },
          { path: "permissions", label: loopFormCopy.permissions, options: LOOP_PERMISSIONS },
        ]}
      />
      <ExpressionField {...props} path="body" label={loopFormCopy.prompt} stream={stream} />
      <div className="min-w-0 wrap-anywhere">
        <PromptMarkdown template={stringValue(fields.value.body)} />
      </div>
      {check.isError && <ErrorAlert message={check.error.message} />}
      <p role="status" className="text-xs text-muted-foreground">
        {checking
          ? loopFormCopy.checking
          : check.data?.problems.length === 0
            ? loopFormCopy.checked
            : null}
      </p>
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={checking || check.isError || problems.length > 0}
        onClick={() => setPreview(fields.value)}
      >
        {loopFormCopy.preview}
      </Button>
      <p className="text-xs text-muted-foreground">{loopFormCopy.paused}</p>
      {preview === fields.value && (
        <LoopPreview key={JSON.stringify(preview)} name={LoopName.make(name)} value={preview} />
      )}
    </div>
  );
};
