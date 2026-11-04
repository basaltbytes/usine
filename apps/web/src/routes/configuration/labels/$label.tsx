import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Option } from "effect";
import { LabelBadge } from "~/components/label-badge";
import { ConfigurationPage, Fact, Facts } from "~/features/configuration/components/section";
import { entityKey } from "~/features/configuration/lib/entities";
import { labelDetailCopy } from "~/features/configuration/strings";
import { configurationQuery } from "~/lib/configuration/queries";

const Label = () => {
  const { label } = Route.useParams();
  const { data } = useSuspenseQuery(configurationQuery());
  const value = data.labels.find(({ name }) => name === label);
  return (
    <ConfigurationPage title={label} entity={entityKey("label", label)}>
      {value !== undefined && (
        <Facts>
          <Fact label={labelDetailCopy.label}>
            <LabelBadge
              name={value.name}
              label={{
                name: value.name,
                color: Option.getOrNull(value.color),
                description: Option.getOrNull(value.description),
              }}
            />
          </Fact>
          <Fact label={labelDetailCopy.description}>
            {Option.getOrElse(value.description, () => labelDetailCopy.noDescription)}
          </Fact>
        </Facts>
      )}
    </ConfigurationPage>
  );
};

export const Route = createFileRoute("/configuration/labels/$label")({ component: Label });
