import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PermissionGrant,
  ProjectScope,
  administratorPermissions,
  permits,
  InstanceScope,
} from "@usine/core/access";
import { Schema } from "effect";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ErrorAlert } from "~/components/error-alert";
import { Acknowledged, authRequest } from "~/lib/auth";
import { usePermissions, sessionQuery } from "~/lib/permissions";
import { configurationQuery } from "~/lib/configuration/queries";
import { tokensQuery } from "~/features/tokens/queries";
import { scopeCopy } from "~/features/tokens/strings";
import { rejectionMessage } from "~/lib/api";

const grantKey = (grant: PermissionGrant) =>
  `${grant.permission}:${grant.scope._tag === "Instance" ? "instance" : grant.scope.project}`;
export const scopeLabel = (grant: PermissionGrant) =>
  grant.permission === "admin"
    ? scopeCopy.instance
    : `${scopeCopy[grant.permission]} · ${grant.scope._tag === "Instance" ? "Instance" : grant.scope.project}`;
type TokenScopesProps = {
  readonly token?: { readonly id: string; readonly scopes: ReadonlyArray<PermissionGrant> };
  readonly close?: () => void;
};
export const TokenScopes = ({ token, close }: TokenScopesProps) => {
  const permissions = usePermissions();
  const configuration = useQuery(configurationQuery());
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<ReadonlyArray<PermissionGrant>>(
    token?.scopes.filter((grant) => permits(permissions, grant.permission, grant.scope)) ?? [],
  );
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const choices = permits(permissions, "admin", InstanceScope.make())
    ? [
        ...administratorPermissions,
        ...(configuration.data?.projects ?? []).flatMap((project) => {
          const id = project.id;
          return id === undefined
            ? []
            : (["read", "operate", "maintain"] as const).map((permission) =>
                PermissionGrant.make({ permission, scope: ProjectScope.make({ project: id }) }),
              );
        }),
      ]
    : permissions;
  const save = async () => {
    setPending(true);
    setError("");
    try {
      const scopes = Schema.encodeSync(Schema.Array(PermissionGrant))(selected);
      if (token === undefined) {
        const issued = await authRequest("/api/tokens", Schema.Struct({ token: Schema.String }), {
          method: "POST",
          body: { name, scopes },
        });
        setSecret(issued.token);
      } else
        await authRequest(`/api/tokens/${encodeURIComponent(token.id)}/scopes`, Acknowledged, {
          method: "PUT",
          body: { scopes },
        });
      await Promise.all([
        client.invalidateQueries(tokensQuery()),
        client.invalidateQueries(sessionQuery()),
      ]);
      close?.();
    } catch (cause) {
      setError(rejectionMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {token === undefined && (
        <Label className="flex flex-col items-start gap-2">
          {scopeCopy.name}
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={100}
          />
        </Label>
      )}
      <fieldset className="space-y-2">
        <legend>{scopeCopy.title}</legend>
        {choices.map((grant) => (
          <Label key={grantKey(grant)} className="flex gap-2">
            <Checkbox
              checked={selected.some((entry) => grantKey(entry) === grantKey(grant))}
              onCheckedChange={(checked) =>
                setSelected((previous) =>
                  checked
                    ? [...previous, grant]
                    : previous.filter((entry) => grantKey(entry) !== grantKey(grant)),
                )
              }
            />
            {scopeLabel(grant)}
          </Label>
        ))}
      </fieldset>
      {error && <ErrorAlert message={error} />}
      {secret && (
        <Label className="flex flex-col items-start gap-2">
          {scopeCopy.once}
          <Input readOnly value={secret} />
        </Label>
      )}
      <Button type="submit" disabled={pending}>
        {token === undefined ? scopeCopy.create : scopeCopy.save}
      </Button>
      {close && (
        <Button type="button" variant="ghost" onClick={close}>
          {scopeCopy.cancel}
        </Button>
      )}
    </form>
  );
};
