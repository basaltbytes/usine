import { Link } from "@tanstack/react-router";
import { configurationQuery } from "~/lib/configuration/queries";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { CommandButton } from "~/components/command-palette/button";
import { PageHeading } from "~/components/page";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ErrorAlert } from "~/components/error-alert";
import { Acknowledged, authRequest, type AuthRequestOptions } from "~/lib/auth";
import { rejectionMessage } from "~/lib/api";
import { membersQuery } from "./queries";
import {
  title,
  adminAccess,
  loginLabel,
  addMember,
  adding,
  removeMember,
  confirmRemove,
  keepMember,
  addedBy,
  bindingsTitle,
  memberTitle,
  actionsTitle,
  noBindings,
  instanceScope,
} from "./strings";

export const MembersPage = () => {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(membersQuery());
  const { data: configuration } = useSuspenseQuery(configurationQuery());
  const [login, setLogin] = useState("");
  const [removing, setRemoving] = useState<number>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const save = async (path: string, method: string, body?: Readonly<Record<string, string>>) => {
    setPending(true);
    setError(undefined);
    try {
      const options: AuthRequestOptions = { method };
      if (body !== undefined) options.body = body;
      await authRequest(path, Acknowledged, options);
      setLogin("");
      setRemoving(undefined);
      await queryClient.invalidateQueries(membersQuery());
    } catch (cause) {
      setError(rejectionMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="space-y-6 p-4 md:p-5">
      <div>
        <PageHeading title={title} />
        <p className="mt-2 text-sm text-muted-foreground">{adminAccess}</p>
      </div>
      {error !== undefined && <ErrorAlert message={error} />}
      <form
        className="flex max-w-lg flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save("/api/members", "POST", { login });
        }}
      >
        <div className="min-w-48 flex-1 space-y-2">
          <Label htmlFor="member-login">{loginLabel}</Label>
          <Input
            id="member-login"
            value={login}
            onChange={(event) => setLogin(event.target.value)}
            autoComplete="off"
            required
            maxLength={39}
          />
        </div>
        <CommandButton type="submit" command={addMember} disabled={pending || login.trim() === ""}>
          {pending ? adding : addMember}
        </CommandButton>
      </form>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{memberTitle}</TableHead>
            <TableHead scope="col">{bindingsTitle}</TableHead>
            <TableHead scope="col">
              <span className="sr-only">{actionsTitle}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((member) => (
            <TableRow key={member.id}>
              <TableCell className="whitespace-normal">
                <div>
                  <p className="text-sm font-medium">{member.login}</p>
                  <p className="text-xs text-muted-foreground">
                    GitHub ID: {member.id} · {addedBy} {member.addedBy} ·{" "}
                    {new Date(member.addedAt).toLocaleDateString()}
                  </p>
                </div>
              </TableCell>
              <TableCell className="whitespace-normal">
                {configuration.bindings.some((binding) => binding.member === member.id) ? (
                  <ul className="space-y-1">
                    {configuration.bindings
                      .filter((binding) => binding.member === member.id)
                      .map((binding) => (
                        <li key={binding.name}>
                          <Link
                            to="/configuration/bindings/$binding"
                            params={{ binding: binding.name }}
                            className="text-primary hover:underline"
                          >
                            {binding.role} ·{" "}
                            {binding.scope._tag === "Instance"
                              ? instanceScope
                              : binding.scope.project}
                          </Link>
                        </li>
                      ))}
                  </ul>
                ) : (
                  <span className="text-muted-foreground">{noBindings}</span>
                )}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap justify-end gap-2">
                  {removing === member.id ? (
                    <>
                      <Button
                        variant="destructive"
                        disabled={pending}
                        onClick={() => void save(`/api/members/${member.id}`, "DELETE")}
                      >
                        {confirmRemove}
                      </Button>
                      <Button variant="ghost" onClick={() => setRemoving(undefined)}>
                        {keepMember}
                      </Button>
                    </>
                  ) : (
                    <CommandButton
                      command={`${removeMember} · ${member.login}`}
                      variant="ghost"
                      disabled={pending || data.length === 1}
                      onClick={() => setRemoving(member.id)}
                      aria-label={`${removeMember} ${member.login}`}
                    >
                      {removeMember}
                    </CommandButton>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
};
