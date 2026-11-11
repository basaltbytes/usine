import { Link, useNavigate } from "@tanstack/react-router";
import type { ConfigurationView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { FillCell } from "~/components/fill-cell";
import { LabelBadge } from "~/components/label-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { ListEmpty } from "~/features/configuration/components/list-empty";
import {
  ConfigurationPage,
  OpeningRow,
  rowLinkClass,
} from "~/features/configuration/components/section";
import { emptyListCopy, labelDetailCopy, plural } from "~/features/configuration/strings";

type LabelRowProps = { readonly label: ConfigurationView["labels"][number] };

const LabelRow = ({ label }: LabelRowProps) => {
  const navigate = useNavigate();
  const params = { label: label.name };
  const description = Option.getOrNull(label.description);
  return (
    <OpeningRow open={() => void navigate({ to: "/configuration/labels/$label", params })}>
      <TableCell className="py-3">
        <Link
          to="/configuration/labels/$label"
          params={params}
          onClick={(event) => event.stopPropagation()}
          className={rowLinkClass}
        >
          <LabelBadge
            name={label.name}
            label={{ name: label.name, color: Option.getOrNull(label.color), description }}
          />
        </Link>
      </TableCell>
      <FillCell className="whitespace-normal">
        {description ?? (
          <span className="text-muted-foreground">{labelDetailCopy.noDescription}</span>
        )}
      </FillCell>
    </OpeningRow>
  );
};

type LabelsListProps = { readonly configuration: ConfigurationView };

export const LabelsList = ({ configuration }: LabelsListProps) => (
  <ConfigurationPage
    title="Labels"
    createKind="label"
    empty={configuration.labels.length === 0}
    counts={plural(configuration.labels.length, "label")}
  >
    {configuration.labels.length === 0 ? (
      <ListEmpty {...emptyListCopy.label} />
    ) : (
      <div className="-mx-2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{labelDetailCopy.label}</TableHead>
              <TableHead>{labelDetailCopy.description}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {configuration.labels.map((label) => (
              <LabelRow key={label.name} label={label} />
            ))}
          </TableBody>
        </Table>
      </div>
    )}
  </ConfigurationPage>
);
