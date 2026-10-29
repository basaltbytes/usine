import { createFileRoute } from "@tanstack/react-router";
import { ConfigurationPage } from "~/features/configuration/components/section";
import { entityKey } from "~/features/configuration/lib/entities";

const Label = () => {
  const { label } = Route.useParams();
  return (
    <ConfigurationPage title={label} entity={entityKey("label", label)}>
      {null}
    </ConfigurationPage>
  );
};

export const Route = createFileRoute("/configuration/labels/$label")({ component: Label });
