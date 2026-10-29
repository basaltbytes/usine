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
} from "./strings";

export const MembersPage = () => {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(membersQuery());
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
        <h1 className="text-xl font-semibold">{title}</h1>
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
        <Button disabled={pending || login.trim() === ""}>{pending ? adding : addMember}</Button>
      </form>
      <ul className="divide-y divide-border">
        {data.map((member) => (
          <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div>
              <p className="text-sm font-medium">{member.login}</p>
              <p className="text-xs text-muted-foreground">
                {addedBy} {member.addedBy} · {new Date(member.addedAt).toLocaleDateString()}
              </p>
            </div>
            <div className="flex gap-2">
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
                <Button
                  variant="ghost"
                  disabled={pending || data.length === 1}
                  onClick={() => setRemoving(member.id)}
                  aria-label={`${removeMember} ${member.login}`}
                >
                  {removeMember}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};
