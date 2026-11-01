---
status: proposed
---

# One model-access policy for parents and children

The Pi parent resolves authentication inside the orchestrator, while vendor children use worker or gateway credentials. This proposal introduces `ModelAccess` to assign a verified billing pool and admit requests consistently across both paths. Keep Pi and pi-durable while introducing the port; change the parent harness only after proving the existing intervention and recovery contract. The [research report](../research/model-access.md) contains the evidence, acceptance tests, and incomplete live validation for [#800](https://github.com/basaltbytes/usine/issues/800).

## Proposed ownership

Define the port, schemas, typed refusals, and deterministic policy in a platform-free capability module. The gateway implements the authority for credentials it manages; the orchestrator uses a remote client and Pi provider adapter. Local instances can provide the same capability in process. Each credential has exactly one authority for refresh and admission state, even when several runtimes use it. A shared library alone cannot coordinate rate windows.

Bind each session to a provider, model, credential identity and revision, transport kind, and pool before generation. An API key selects the API keys pool, including a key with subscription-linked API credits. A vendor-client subscription route selects its supported plan pool. A gateway reload cannot silently change an existing binding. Refuse credentials whose billing source cannot be represented, and never infer subscription access from a model name or a placeholder key.

Apply fresh known exhaustion and provider backoff to every caller of a credential. Preserve observation source, age, scope, and reset time; unknown capacity stays unknown. Keep native usage meters and mark estimates separately. Reconcile gateway attribution and harness usage as observations of one request, with idempotent recording across restart. Do not automatically change pools, enable Extra Usage, or replay an ambiguously completed generation.

The parent receives a model-call scope bound to its run, attempt, and session. Member conversations require a separate explicit scope; neither path receives gateway administration credentials. Vendor children retain their existing caller-token path. Keep provider credentials inside the owning adapter and preserve vendor streaming protocols.

## Alternatives

A gateway-only HTTP proxy cannot implement the parent session protocol or turn raw Pi calls into subscription-eligible vendor-client calls. Sharing policy code without one state owner leaves concurrent parents and children with inconsistent admission decisions. Replacing Pi at the same time would combine transport, accounting, and durable-session migrations, making a recovery regression harder to isolate.

A bridge can execute the unmodified vendor client while Pi remains the parent, but it adds transcript synchronization and another session store. The measured standalone Pi behavior does not establish usine reattachment or Claude-plan billing. Keep bridge adoption disabled until its durable adapter, authoritative pool mapping, complete attempt, crash recovery, and account-side billing checks pass.

## Consequences and acceptance

This is a proposal, not authorization to expand subscription use. It does not change runtime behavior or supersede an accepted ADR. Provider terms constrain which routes can be enabled; successful requests and zero cost fields do not establish either permission or billing.

Implementation amends ADR 0005 for injected model access while retaining Pi, ADR 0013 for credential-bound accounting and known-exhaustion admission, ADR 0021 for verified parent pool resolution, and ADR 0027 for parent/member scopes and shared credential authority. The report lists the exact amendments and test matrix. A later native parent must preserve holds, steering, interruption, release, child budgets, usage events, and restart reconciliation before replacing Pi for new attempts.

Accept this proposal only after reviewing the remaining bridge experiment and source limitations in the research report. Deploy the port independently of the bridge or a native parent, and require its deterministic policy, transport, and durability tests before enabling new routes.
