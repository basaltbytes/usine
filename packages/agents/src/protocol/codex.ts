import { Schema } from "effect";

/**
 * Request types sent to the Codex app server, copied from
 * `@pwrdrvr/codex-app-server-protocol@0.159.2` (codex-cli 0.159.2) because that package resolves
 * only under bundler module resolution. `protocol-conformance/check.ts` fails `pnpm check` if these
 * types drift from the package.
 */
export interface InitializeParams {
  readonly clientInfo: {
    readonly name: string;
    readonly title: string | null;
    readonly version: string;
  };
  readonly capabilities: null;
}

export interface ModelListParams {
  readonly cursor?: string | null;
  readonly limit?: number | null;
  readonly includeHidden?: boolean | null;
}

export interface GetAccountParams {
  readonly refreshToken?: boolean;
}

export interface ThreadStartParams {
  readonly model?: string | null;
  readonly allowProviderModelFallback?: boolean;
  readonly cwd?: string | null;
  readonly approvalPolicy?: "never" | "on-request" | "untrusted" | null;
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null;
  readonly serviceName?: string | null;
  readonly ephemeral?: boolean | null;
}

interface TextInput {
  readonly type: "text";
  readonly text: string;
  readonly text_elements: ReadonlyArray<never>;
}

export interface TurnStartParams {
  readonly threadId: string;
  readonly input: ReadonlyArray<TextInput>;
  readonly cwd?: string | null;
  readonly approvalPolicy?: "never" | "on-request" | "untrusted" | null;
  readonly sandboxPolicy?: { readonly type: "dangerFullAccess" } | null;
  readonly effort?: string | null;
}

export interface TurnSteerParams {
  readonly threadId: string;
  readonly expectedTurnId: string;
  readonly input: ReadonlyArray<TextInput>;
}

export interface TurnInterruptParams {
  readonly threadId: string;
  readonly turnId: string;
}

// Decodes only the authentication type, so account identity is never logged.
export const AccountResponse = Schema.Struct({
  account: Schema.NullOr(Schema.Struct({ type: Schema.String })),
  requiresOpenaiAuth: Schema.Boolean,
});
export const AccountUpdated = Schema.Struct({ authMode: Schema.NullOr(Schema.String) });
