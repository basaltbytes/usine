import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { type FormFieldsProps, fieldValue, withField } from "~/features/configuration/lib/forms";
import { formCopy, workerFormCopy as copy } from "~/features/configuration/strings";
import { Fields, type FieldDefinition } from "./fields";
import { Pairs } from "./pairs";

const timingFields: readonly FieldDefinition[] = [
  { path: "provisioner.timings.ssh_wait", label: copy.sshWait, kind: "number", optional: true },
  {
    path: "provisioner.timings.creation_backoff_min",
    label: copy.backoffMin,
    kind: "number",
    optional: true,
  },
  {
    path: "provisioner.timings.creation_backoff_max",
    label: copy.backoffMax,
    kind: "number",
    optional: true,
  },
  {
    path: "provisioner.timings.machine_check_interval",
    label: copy.checkInterval,
    kind: "number",
    optional: true,
  },
];

export const ProvisionerFields = (fields: FormFieldsProps) => {
  const provider = fieldValue(fields.value, "provisioner.provider");
  return (
    <div className="space-y-4">
      <Fields
        {...fields}
        definitions={[
          { path: "provisioner.token_env", label: copy.token, description: formCopy.secret },
          ...(provider === "hetzner"
            ? [
                { path: "provisioner.server_type", label: copy.serverType },
                { path: "provisioner.location", label: copy.location },
                { path: "provisioner.image", label: copy.snapshot },
                { path: "provisioner.network", label: copy.network, optional: true },
                { path: "provisioner.firewall", label: copy.firewall, optional: true },
                { path: "provisioner.ssh_key", label: copy.sshKey },
                { path: "provisioner.ssh_user", label: copy.sshUser, optional: true },
              ]
            : [
                { path: "provisioner.size", label: copy.size, optional: true },
                { path: "provisioner.snapshot", label: copy.snapshot, optional: true },
              ]),
          {
            path: "provisioner.api_keys.anthropic",
            label: copy.anthropic,
            optional: true,
            description: formCopy.secret,
          },
          {
            path: "provisioner.api_keys.openai",
            label: copy.openai,
            optional: true,
            description: formCopy.secret,
          },
          ...timingFields,
        ]}
      />
      {provider === "hetzner" && (
        <Pairs {...fields} path="provisioner.labels" label={copy.labels} />
      )}
      {provider === "boat" && (
        <>
          <Label>
            <Checkbox
              checked={fieldValue(fields.value, "provisioner.tailnet") !== undefined}
              onCheckedChange={(checked) =>
                fields.onChange(
                  withField(fields.value, "provisioner.tailnet", checked ? {} : undefined),
                )
              }
            />
            {copy.tailnet}
          </Label>
          {fieldValue(fields.value, "provisioner.tailnet") !== undefined && (
            <Fields
              {...fields}
              definitions={[
                { path: "provisioner.tailnet.gateway_address", label: copy.gatewayAddress },
                {
                  path: "provisioner.tailnet.client_id_env",
                  label: copy.tailnetId,
                  description: formCopy.secret,
                },
                {
                  path: "provisioner.tailnet.client_secret_env",
                  label: copy.tailnetSecret,
                  description: formCopy.secret,
                },
              ]}
            />
          )}
        </>
      )}
    </div>
  );
};
