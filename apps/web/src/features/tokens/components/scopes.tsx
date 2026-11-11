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
  readonly token?: {
    readonly id: string;
    readonly scopes: ReadonlyArray<PermissionGrant>;
    readonly operations?: ReadonlyArray<string>;
  };
  readonly close?: () => void;
};
/** The body of `POST /api/tokens`. */
type TokenCreation = {
  readonly name: string;
  readonly scopes: ReadonlyArray<typeof PermissionGrant.Encoded>;
  operations?: ReadonlyArray<string>;
  expiresAt?: number;
};
/** The body of `PUT /api/tokens/:id/scopes`; null `operations` removes the ceiling. */
type ScopeEdit = {
  readonly scopes: ReadonlyArray<typeof PermissionGrant.Encoded>;
  operations?: ReadonlyArray<string> | null;
};
/** Splits the operation field into operation IDs, such as `operator.approve`. */
const operationList = (text: string) =>
  text
    .split(/[\s,]+/u)
    .map((operation) => operation.trim())
    .filter((operation) => operation !== "");
export const TokenScopes = ({ token, close }: TokenScopesProps) => {
  const permissions = usePermissions();
  const configuration = useQuery(configurationQuery());
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<ReadonlyArray<PermissionGrant>>(
    token?.scopes.filter((grant) => permits(permissions, grant.permission, grant.scope)) ?? [],
  );
  const initialOperations = token?.operations?.join(", ") ?? "";
  const [operations, setOperations] = useState(initialOperations);
  const [expires, setExpires] = useState("");
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
      const ceiling = operationList(operations);
      if (token === undefined) {
        const body: TokenCreation = { name, scopes };
        if (ceiling.length > 0) body.operations = ceiling;
        if (expires !== "") body.expiresAt = new Date(expires).getTime();
        const issued = await authRequest("/api/tokens", Schema.Struct({ token: Schema.String }), {
          method: "POST",
          body,
        });
        setSecret(issued.token);
      } else {
        const body: ScopeEdit = { scopes };
        // An unchanged field keeps the stored ceiling; an emptied field removes it.
        if (operations !== initialOperations) body.operations = ceiling.length > 0 ? ceiling : null;
        await authRequest(`/api/tokens/${encodeURIComponent(token.id)}/scopes`, Acknowledged, {
          method: "PUT",
          body,
        });
      }
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
      <Label className="flex flex-col items-start gap-2">
        {scopeCopy.operations}
        <Input
          value={operations}
          onChange={(event) => setOperations(event.target.value)}
          placeholder="operator.overview, operator.approve"
        />
        <span className="text-xs font-normal text-muted-foreground">
          {scopeCopy.operationsHint}
        </span>
      </Label>
      {token === undefined && (
        <Label className="flex flex-col items-start gap-2">
          {scopeCopy.expires}
          <Input
            type="datetime-local"
            value={expires}
            onChange={(event) => setExpires(event.target.value)}
          />
        </Label>
      )}
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
