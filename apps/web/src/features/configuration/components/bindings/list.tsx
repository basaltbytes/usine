import { Link, useNavigate } from "@tanstack/react-router";
import type { GitHubUserId } from "@usine/core/access";
import type { ConfigurationView } from "@usine/orchestrator/operator";
import { FillCell } from "~/components/fill-cell";
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
import { bindingCopy, emptyListCopy, plural } from "~/features/configuration/strings";

type Binding = ConfigurationView["bindings"][number];

const projectName = (configuration: ConfigurationView, { scope }: Binding) =>
  scope._tag === "Project"
    ? configuration.projects.find(({ id }) => id === scope.project)?.name
    : undefined;

type BindingRowProps = {
  readonly binding: Binding;
  readonly member: string | undefined;
  readonly project: string | undefined;
};

const BindingRow = ({ binding, member, project }: BindingRowProps) => {
  const navigate = useNavigate();
  const params = { binding: binding.name };
  return (
    <OpeningRow open={() => void navigate({ to: "/configuration/bindings/$binding", params })}>
      <TableCell className="py-3">
        <Link
          to="/configuration/bindings/$binding"
          params={params}
          onClick={(event) => event.stopPropagation()}
          className={rowLinkClass}
        >
          {binding.name}
        </Link>
      </TableCell>
      <TableCell>
        {member === undefined ? (
          <span className="text-muted-foreground">{bindingCopy.unenrolledMember}</span>
        ) : (
          <span className="font-mono text-xs">{member}</span>
        )}
      </TableCell>
      <TableCell>{bindingCopy.roles[binding.role]}</TableCell>
      <FillCell className="hidden whitespace-normal sm:table-cell">
        {binding.scope._tag === "Instance" ? (
          <span className="text-muted-foreground">{bindingCopy.instance}</span>
        ) : (
          (project ?? binding.scope.project)
        )}
      </FillCell>
    </OpeningRow>
  );
};

type BindingsListProps = {
  readonly configuration: ConfigurationView;
  readonly members: ReadonlyArray<{ readonly id: GitHubUserId; readonly login: string }>;
  readonly initialMember: string | undefined;
};

/** `initialMember` opens the creation form with that member's login preselected. */
export const BindingsList = ({ configuration, members, initialMember }: BindingsListProps) => (
  <ConfigurationPage
    key={initialMember}
    title={bindingCopy.title}
    createKind="binding"
    initialMember={initialMember}
    empty={configuration.bindings.length === 0}
    counts={plural(configuration.bindings.length, "role binding")}
  >
    {configuration.bindings.length === 0 ? (
      <ListEmpty {...emptyListCopy.binding} />
    ) : (
      <div className="-mx-2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Role binding</TableHead>
              <TableHead>{bindingCopy.member}</TableHead>
              <TableHead>{bindingCopy.role}</TableHead>
              <TableHead className="hidden sm:table-cell">{bindingCopy.scope}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {configuration.bindings.map((binding) => (
              <BindingRow
                key={binding.name}
                binding={binding}
                member={members.find(({ id }) => id === binding.member)?.login}
                project={projectName(configuration, binding)}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    )}
  </ConfigurationPage>
);
