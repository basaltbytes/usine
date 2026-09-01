/**
 * NodeNext-compatible view of the exact-pinned generated app-server protocol
 * (`@pwrdrvr/codex-app-server-protocol@0.144.0`, mirroring codex-cli 0.144.0).
 * The upstream package omits extensions in its generated source, so it only
 * resolves under bundler-style resolution; these are the request shapes usine
 * sends on that pinned wire version. `protocol-conformance/check.ts` compiles
 * against the real package and fails `pnpm check` when this view drifts.
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
