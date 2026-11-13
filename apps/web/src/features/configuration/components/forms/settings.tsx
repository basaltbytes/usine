import { useQuery } from "@tanstack/react-query";
import { Effort } from "@usine/core/agent/brain";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { capabilitiesQuery } from "~/lib/configuration/capabilities";
import { type FormFieldsProps, fieldValue, withField } from "~/features/configuration/lib/forms";
import {
  formCopy,
  settingsFormFields,
  settingsExtraCopy,
  supervisorCopy,
} from "~/features/configuration/strings";
import { Fields } from "./fields";

export const SettingsFields = (fields: FormFieldsProps) => {
  const capabilities = useQuery(capabilitiesQuery());
  const supervisorHarness = fieldValue(fields.value, "settings.supervisor.harness");
  // The note on the selected harness's own tools, as its descriptor gives it.
  const ownTools = capabilities.data?.harnessDetails.find(
    ({ id }) => id === supervisorHarness,
  )?.ownTools;
  return (
    <div className="flex flex-col gap-4">
      <Fields
        {...fields}
        onChange={(next) => {
          const previousMode = fieldValue(fields.value, "webhooks.mode");
          const mode = fieldValue(next, "webhooks.mode");
          fields.onChange(
            previousMode !== mode
              ? withField(
                  next,
                  "webhooks",
                  mode === "endpoint" ? { mode, public_url: "" } : { mode: mode ?? "off" },
                )
              : next,
          );
        }}
        definitions={settingsFormFields.map((field) =>
          field.path === "settings.parent_effort"
            ? { ...field, options: Effort.literals, optional: true }
            : {
                ...field,
                optional: field.path === "operator" || field.path === "settings.parent_model",
              },
        )}
      />
      {fieldValue(fields.value, "webhooks.mode") === "endpoint" && (
        <Fields
          {...fields}
          definitions={[
            {
              path: "webhooks.public_url",
              label: settingsExtraCopy.publicUrl,
              description: settingsExtraCopy.publicUrlHint,
            },
          ]}
        />
      )}
      <Label>
        <Checkbox
          checked={fieldValue(fields.value, "settings.supervisor") !== undefined}
          onCheckedChange={(checked) =>
            fields.onChange(
              withField(
                fields.value,
                "settings.supervisor",
                checked ? { harness: "", model: "", effort: "medium" } : undefined,
              ),
            )
          }
        />
        {settingsExtraCopy.supervisor}
      </Label>
      {fieldValue(fields.value, "settings.supervisor") !== undefined && (
        <Fields
          {...fields}
          definitions={[
            {
              path: "settings.supervisor.harness",
              label: settingsExtraCopy.supervisorHarness,
              options: capabilities.data?.harnesses ?? [],
              description: settingsExtraCopy.supervisorHarnessHint,
            },
            { path: "settings.supervisor.model", label: settingsExtraCopy.supervisorModel },
            {
              path: "settings.supervisor.effort",
              label: settingsExtraCopy.supervisorEffort,
              options: Effort.literals,
            },
          ]}
        />
      )}
      {ownTools !== null && ownTools !== undefined && (
        <p className="text-xs text-muted-foreground">{supervisorCopy.ownToolsEffect(ownTools)}</p>
      )}
      <Label>
        <Checkbox
          checked={fields.value.tracing !== undefined}
          onCheckedChange={(checked) =>
            fields.onChange(
              withField(
                fields.value,
                "tracing",
                checked ? { otlp_url: "", service_name: "usine" } : undefined,
              ),
            )
          }
        />
        {settingsExtraCopy.tracing}
      </Label>
      {fields.value.tracing !== undefined && (
        <Fields
          {...fields}
          definitions={[
            {
              path: "tracing.otlp_url",
              label: settingsExtraCopy.otlp,
              description: settingsExtraCopy.otlpHint,
            },
            {
              path: "tracing.service_name",
              label: settingsExtraCopy.service,
              description: settingsExtraCopy.serviceHint,
            },
          ]}
        />
      )}
      <p className="text-xs text-muted-foreground">{formCopy.restartSettings}</p>
    </div>
  );
};
