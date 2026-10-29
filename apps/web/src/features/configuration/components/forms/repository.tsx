import { ListField } from "./list-field";
import { FormField } from "./fields";
import type { FormFieldsProps } from "~/features/configuration/lib/forms";
import { formCopy } from "~/features/configuration/strings";

export const RepositoryFields = (fields: FormFieldsProps) => (
  <div className="min-w-0 space-y-5">
    <FormField {...fields} path="name" label={formCopy.repositories} readOnly />
    <ListField {...fields} path="tags" label={formCopy.tags} />
  </div>
);
