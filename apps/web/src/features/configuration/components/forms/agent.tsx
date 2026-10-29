import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { ErrorAlert } from "~/components/error-alert";
import { Markdown } from "~/components/markdown";
import { type FormFieldsProps, stringValue } from "~/features/configuration/lib/forms";
import { capabilitiesQuery } from "~/features/configuration/queries";
import { formCopy } from "~/features/configuration/strings";
import { configurationQuery } from "~/lib/configuration/queries";
import { Fields, FormField } from "./fields";

export const AgentFields = (fields: FormFieldsProps) => {
  const capabilities = useQuery(capabilitiesQuery());
  const configuration = useQuery(configurationQuery());
  const [preview, setPreview] = useState(false);
  const models = [
    ...new Set(
      configuration.data?.agents
        .filter((agent) => agent.harness === fields.value.harness)
        .map((agent) => agent.model) ?? [],
    ),
  ];
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {capabilities.isPending && <p role="status">{formCopy.loading}</p>}
      {capabilities.isError && <ErrorAlert message={capabilities.error.message} />}
      <Fields
        {...fields}
        definitions={[
          { path: "name", label: formCopy.name, readOnly: true, description: formCopy.identity },
          { path: "harness", label: formCopy.harness, options: capabilities.data?.harnesses ?? [] },
          {
            path: "model",
            label: formCopy.model,
            suggestions: models,
            description: formCopy.modelHint,
          },
          { path: "effort", label: formCopy.effort, options: capabilities.data?.efforts ?? [] },
        ]}
      />
      <FormField {...fields} path="persona" label={formCopy.persona} kind="textarea" />
      <Button
        type="button"
        variant="outline"
        className="self-start"
        onClick={() => setPreview(!preview)}
        aria-expanded={preview}
      >
        {preview ? formCopy.hidePreview : formCopy.preview}
      </Button>
      {preview && (
        <div className="min-w-0 wrap-anywhere">
          <Markdown>{stringValue(fields.value.persona)}</Markdown>
        </div>
      )}
    </div>
  );
};
