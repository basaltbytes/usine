import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ProjectRole } from "@usine/core/access";
import { ErrorAlert } from "~/components/error-alert";
import { Button } from "~/components/ui/button";
import { objectValue, stringValue, type FormFieldsProps } from "~/features/configuration/lib/forms";
import { bindingCopy, editorCopy } from "~/features/configuration/strings";
import { configurationQuery } from "~/lib/configuration/queries";
import { membersQuery } from "~/lib/members/queries";
import { FormField } from "~/features/configuration/components/forms/fields";

export const BindingFields = (fields: FormFieldsProps) => {
  const { value, onChange } = fields;
  const members = useQuery(membersQuery());
  const configuration = useQuery(configurationQuery());
  const scope = objectValue(value.scope);
  const instance = scope._tag === "Instance";
  const member = stringValue(value.member);
  const choices = members.data?.map(({ id, login }) => ({ value: String(id), label: login })) ?? [];
  if (member !== "" && members.isSuccess && !choices.some(({ value }) => value === member))
    choices.push({ value: member, label: bindingCopy.unenrolledMember });
  return (
    <div className="min-w-0 space-y-4">
      {members.isPending && <p role="status">{bindingCopy.loadingMembers}</p>}
      {members.isError && (
        <div className="space-y-2">
          <ErrorAlert message={members.error.message} />
          <Button type="button" variant="outline" onClick={() => void members.refetch()}>
            {bindingCopy.retryMembers}
          </Button>
        </div>
      )}
      {members.isSuccess && members.data.length === 0 && (
        <p className="text-muted-foreground">
          {bindingCopy.noMembers}{" "}
          <Link to="/members" className="text-primary hover:underline">
            {bindingCopy.members}
          </Link>
        </p>
      )}
      {configuration.isError && <ErrorAlert message={configuration.error.message} />}
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <FormField {...fields} path="name" label={editorCopy.name} readOnly />
        <FormField
          {...fields}
          path="member"
          label={bindingCopy.member}
          kind="number"
          labeledOptions={choices}
          readOnly={!members.isSuccess}
        />
        <FormField
          {...fields}
          problems={fields.problems.map((problem) =>
            problem.path[0] === "scope" ? { ...problem, path: ["scope"] } : problem,
          )}
          path="scope"
          label={bindingCopy.scope}
          description={bindingCopy.instanceHint}
          value={{
            ...value,
            scope: instance
              ? "instance"
              : scope._tag === "Project"
                ? `project:${stringValue(scope.project)}`
                : "",
          }}
          labeledOptions={[
            { value: "instance", label: bindingCopy.instance },
            ...(configuration.data?.projects.map(({ id, name }) => ({
              value: `project:${id}`,
              label: name,
            })) ?? []),
          ]}
          onChange={(next) => {
            const selected = stringValue(next.scope);
            onChange({
              ...value,
              scope:
                selected === "instance"
                  ? { _tag: "Instance" }
                  : selected === ""
                    ? {}
                    : { _tag: "Project", project: selected.slice("project:".length) },
              role:
                selected === "instance"
                  ? "admin"
                  : value.role === "admin"
                    ? "viewer"
                    : (value.role ?? "viewer"),
            });
          }}
        />
        <FormField
          {...fields}
          path="role"
          label={bindingCopy.role}
          options={instance ? ["admin"] : ProjectRole.literals}
        />
      </div>
    </div>
  );
};
