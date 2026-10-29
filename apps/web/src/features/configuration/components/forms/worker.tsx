import { ListField } from "./list-field";
import { useQuery } from "@tanstack/react-query";
import { Worker } from "@usine/config/factory";
import { CloudflareInstanceType, CloudflareLlmProvider } from "@usine/core/worker";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import {
  type FormFieldsProps,
  arrayValue,
  fieldValue,
  objectValue,
  stringValue,
  withField,
} from "~/features/configuration/lib/forms";
import { formCopy, workerFormCopy as copy } from "~/features/configuration/strings";
import { configurationQuery } from "~/lib/configuration/queries";
import { Fields, FormField } from "./fields";
import { ProvisionerFields } from "./provisioner";

const CloudflareKeys = (fields: FormFieldsProps) => {
  const keys = arrayValue(fields.value.llm_providers).map(objectValue);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {CloudflareLlmProvider.literals.map((provider) => {
        const index = keys.findIndex((key) => key.provider === provider);
        return (
          <FormField
            key={provider}
            path="api_key_env"
            label={provider === "anthropic" ? copy.anthropic : copy.openai}
            description={formCopy.secret}
            optional
            value={index < 0 ? {} : objectValue(keys[index])}
            problems={fields.problems
              .filter((problem) => problem.path[0] === "llm_providers" && problem.path[1] === index)
              .map((problem) => ({ ...problem, path: problem.path.slice(2) }))}
            onChange={(next) =>
              fields.onChange({
                ...fields.value,
                llm_providers: [
                  ...keys.filter((key) => key.provider !== provider),
                  ...(next.api_key_env === undefined
                    ? []
                    : [{ provider, api_key_env: next.api_key_env }]),
                ],
              })
            }
          />
        );
      })}
    </div>
  );
};

export const WorkerFields = (fields: FormFieldsProps) => {
  const configuration = useQuery(configurationQuery());
  const applied = configuration.data?.workers.find(
    (worker) => worker.name === fields.value.name,
  )?.containerLimits;
  const provider = stringValue(fieldValue(fields.value, "provisioner.provider"));
  const limitHint = (value: number | undefined) =>
    value === undefined
      ? formCopy.derived
      : `${formCopy.lastPreflight}: ${value}. ${formCopy.derived}.`;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Fields
        {...fields}
        onChange={(next) =>
          fields.onChange(
            next.kind === fields.value.kind
              ? next
              : {
                  name: next.name ?? "",
                  kind: next.kind ?? "local",
                  max_concurrent_attempts: next.max_concurrent_attempts ?? 1,
                },
          )
        }
        definitions={[
          { path: "name", label: formCopy.name, readOnly: true, description: formCopy.identity },
          {
            path: "kind",
            label: copy.kind,
            options: Worker.members.map((schema) => schema.fields.kind.literal),
          },
          {
            path: "max_concurrent_attempts",
            label: copy.slots,
            kind: "number",
            description: copy.slotsHint,
          },
        ]}
      />
      {fields.value.kind === "ssh" && (
        <>
          <Label className="flex flex-col items-start gap-2">
            {formCopy.provisioner}
            <NativeSelect
              value={provider}
              onChange={(event) => {
                const selected = event.target.value;
                const next = withField(
                  fields.value,
                  "provisioner",
                  selected === "" ? undefined : { provider: selected },
                );
                fields.onChange(
                  withField(
                    withField(next, "destination", selected === "" ? "" : undefined),
                    "port",
                    undefined,
                  ),
                );
              }}
            >
              <option value="">{formCopy.existing}</option>
              <option value="hetzner">Hetzner</option>
              <option value="boat">Boat</option>
            </NativeSelect>
          </Label>
          <Fields
            {...fields}
            definitions={[
              { path: "root", label: copy.root },
              { path: "identity_file", label: copy.identity, optional: true },
              ...(provider === ""
                ? [
                    { path: "destination", label: copy.destination },
                    { path: "port", label: copy.port, kind: "number" as const, optional: true },
                  ]
                : []),
            ]}
          />
          {provider !== "" && <ProvisionerFields {...fields} />}
          <fieldset className="space-y-3">
            <legend className="mb-3 font-medium">{formCopy.container}</legend>
            <Fields
              {...fields}
              definitions={[
                { path: "container.image", label: copy.image, optional: true },
                {
                  path: "container.cpus",
                  label: copy.cpus,
                  kind: "number",
                  description: limitHint(applied?.cpus),
                },
                {
                  path: "container.memory_mib",
                  label: copy.memory,
                  kind: "number",
                  description: limitHint(applied?.memoryMib),
                },
                {
                  path: "container.pids",
                  label: copy.pids,
                  kind: "number",
                  description: limitHint(applied?.pids),
                },
              ]}
            />
          </fieldset>
          <Label>
            <Checkbox
              checked={fields.value.gateway !== undefined}
              onCheckedChange={(checked) =>
                fields.onChange(withField(fields.value, "gateway", checked ? {} : undefined))
              }
            />
            {formCopy.gateway}
          </Label>
          {fields.value.gateway !== undefined && (
            <>
              <Fields
                {...fields}
                definitions={[
                  { path: "gateway.domain", label: copy.domain },
                  { path: "gateway.destination", label: copy.gatewayDestination },
                  { path: "gateway.admin_port", label: copy.adminPort, kind: "number" },
                  {
                    path: "gateway.admin_token_env",
                    label: copy.adminToken,
                    description: formCopy.secret,
                  },
                ]}
              />
              <ListField {...fields} path="gateway.llm_providers" label={copy.providers} />
            </>
          )}
        </>
      )}
      {fields.value.kind === "cloudflare" && (
        <>
          <Fields
            {...fields}
            definitions={[
              { path: "worker_url", label: copy.url },
              { path: "access_client_id_env", label: copy.clientId, description: formCopy.secret },
              {
                path: "access_client_secret_env",
                label: copy.clientSecret,
                description: formCopy.secret,
              },
              { path: "image", label: copy.image },
              {
                path: "instance_type",
                label: copy.instanceType,
                options: CloudflareInstanceType.literals,
              },
            ]}
          />
          <CloudflareKeys {...fields} />
        </>
      )}
      <p className="text-xs text-muted-foreground">{formCopy.restartWorker}</p>
    </div>
  );
};
