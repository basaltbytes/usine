import { Effort } from "@usine/core/agent/brain";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { type FormFieldsProps, fieldValue, withField } from "~/features/configuration/lib/forms";
import { formCopy, settingsFormFields, settingsExtraCopy } from "~/features/configuration/strings";
import { Fields } from "./fields";

export const SettingsFields = (fields: FormFieldsProps) => (
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
