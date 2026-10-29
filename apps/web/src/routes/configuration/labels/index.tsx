import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Option } from "effect";
import { LabelBadge } from "~/components/label-badge";
import { editorCopy } from "~/features/configuration/strings";
import { ConfigurationPage, Missing } from "~/features/configuration/components/section";
import { configurationQuery } from "~/lib/configuration/queries";

const Labels = () => {
  const { data } = useSuspenseQuery(configurationQuery());
  return (
    <ConfigurationPage title="Labels" createKind="label">
      {data.labels.length === 0 && (
        <Missing title={editorCopy.noLabels}>{editorCopy.addLabel}</Missing>
      )}
      <ul className="divide-y border-y">
        {data.labels.map((label) => (
          <li
            key={label.name}
            className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 py-3 wrap-anywhere"
          >
            <Link
              to="/configuration/labels/$label"
              params={{ label: label.name }}
              className="text-primary hover:underline"
            >
              <LabelBadge
                name={label.name}
                label={{
                  name: label.name,
                  color: Option.getOrNull(label.color),
                  description: Option.getOrNull(label.description),
                }}
              />
            </Link>
            <span className="text-muted-foreground">{Option.getOrNull(label.description)}</span>
          </li>
        ))}
      </ul>
    </ConfigurationPage>
  );
};

export const Route = createFileRoute("/configuration/labels/")({ component: Labels });
