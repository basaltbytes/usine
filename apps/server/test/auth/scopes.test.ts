import { assert, it } from "@effect/vitest";
import { Clock, Effect, Option, Redacted } from "effect";
import { TestClock } from "effect/testing";
import {
  RoleBinding,
  ProjectScope,
  PermissionGrant,
  administratorPermissions,
  permits,
} from "@usine/core/access";
import { ProjectId } from "@usine/core/project";
import { alice, authFixture, localSecret } from "./fixture.ts";
import {
  type AuthError,
  InstanceToken,
  OperationCeilingChange,
  OperationId,
  TokenId,
  TokenName,
} from "../../src/auth/model.ts";
import { secretHash } from "../../src/auth/crypto.ts";

const deviceToken = (
  name: string,
  scopes: ReadonlyArray<PermissionGrant>,
  operations: Option.Option<ReadonlyArray<OperationId>> = Option.none(),
  expiresAt: Option.Option<number> = Option.none(),
) => ({ name: TokenName.make(name), scopes, operations, expiresAt });

const browserSession = Effect.fn(function* (
  auth: Effect.Success<ReturnType<typeof authFixture>>["authentication"],
) {
  const current = yield* auth.link;
  const link = new URL(current);
  const session = yield* auth.consumeLink(
    new URLSearchParams(link.hash.slice(1)).get("link") ?? "",
  );
  return Redacted.value(session.secret);
});

it.live(
  "keeps local attribution separate from members and limits issued tokens to current grants",
  () =>
    Effect.gen(function* () {
      const alpha = ProjectScope.make({ project: ProjectId.make("alpha") });
      const beta = ProjectScope.make({ project: ProjectId.make("beta") });
      let grants: ReadonlyArray<PermissionGrant> = RoleBinding.make({
        name: "alice-alpha",
        member: alice.id,
        role: "maintainer",
        scope: alpha,
      }).permissions;
      const services = yield* authFixture([alice], alice, () => grants);
      const auth = services.authentication;
      const local = yield* auth.authenticate(localSecret);
      assert.isTrue(Option.isNone(local.member));
      const currentLink = yield* auth.link;
      const url = new URL(currentLink);
      const session = yield* auth.consumeLink(
        new URLSearchParams(url.hash.slice(1)).get("link") ?? "",
      );
      const secret = Redacted.value(session.secret);
      const refused = yield* auth
        .createToken(secret, deviceToken("Too wide", administratorPermissions))
        .pipe(Effect.flip);
      assert.equal(refused.status, 403);
      const issued = yield* auth.createToken(
        secret,
        deviceToken("Read alpha", [PermissionGrant.make({ permission: "read", scope: alpha })]),
      );
      const access = yield* auth.authenticate(Redacted.value(issued.secret));
      assert.isTrue(permits(access.permissions, "read", alpha));
      assert.isFalse(permits(access.permissions, "read", beta));
      assert.isFalse(permits(access.permissions, "operate", alpha));
      const tokens = yield* services.store.tokens(alice.id);
      const device = tokens.find(({ kind }) => kind === "device");
      assert.isDefined(device);
      if (device === undefined) return;
      yield* auth.setScopes(secret, device.id, grants, OperationCeilingChange.Keep());
      assert.isTrue(
        permits(
          (yield* auth.authenticate(Redacted.value(issued.secret))).permissions,
          "maintain",
          alpha,
        ),
      );
      grants = [];
      assert.deepEqual((yield* auth.authenticate(Redacted.value(issued.secret))).permissions, []);
    }).pipe(Effect.scoped),
);

for (const initialRole of ["none", "viewer"] as const)
  it.live(
    `updates the same browser session when a ${initialRole} member gains an operator binding`,
    () =>
      Effect.gen(function* () {
        const alpha = ProjectScope.make({ project: ProjectId.make("alpha") });
        const binding = RoleBinding.make({
          name: "alice-alpha",
          member: alice.id,
          role: "operator",
          scope: alpha,
        });
        let grants: ReadonlyArray<PermissionGrant> =
          initialRole === "none"
            ? []
            : RoleBinding.make({ ...binding, role: "viewer" }).permissions;
        const { authentication: auth, store } = yield* authFixture([alice], alice, () => grants);
        const started = yield* auth.startWeb(false);
        const session = yield* auth.finishWeb(Redacted.value(started.state), "code");
        const secret = Redacted.value(session.secret);
        assert.isFalse(permits((yield* auth.authenticate(secret)).permissions, "operate", alpha));
        grants = binding.permissions;
        assert.isTrue(permits((yield* auth.authenticate(secret)).permissions, "operate", alpha));
        const device = yield* auth.createToken(secret, deviceToken("Operator", grants));
        assert.isTrue(
          permits(
            (yield* auth.authenticate(Redacted.value(device.secret))).permissions,
            "operate",
            alpha,
          ),
        );
        grants = RoleBinding.make({ ...binding, role: "maintainer" }).permissions;
        assert.isFalse(
          permits(
            (yield* auth.authenticate(Redacted.value(device.secret))).permissions,
            "maintain",
            alpha,
          ),
        );
        const browser = (yield* store.tokens(alice.id)).find(({ kind }) => kind === "session");
        assert.isDefined(browser);
        if (browser === undefined) return;
        assert.equal(
          (yield* auth
            .setScopes(secret, browser.id, [], OperationCeilingChange.Keep())
            .pipe(Effect.flip)).status,
          400,
        );
      }).pipe(Effect.scoped),
  );

it.live("uses current bindings for a browser session with a stored scope ceiling", () =>
  Effect.gen(function* () {
    const alpha = ProjectScope.make({ project: ProjectId.make("alpha") });
    const binding = RoleBinding.make({
      name: "alice-alpha",
      member: alice.id,
      role: "operator",
      scope: alpha,
    });
    const { authentication: auth, store } = yield* authFixture(
      [alice],
      alice,
      () => binding.permissions,
    );
    const now = yield* Clock.currentTimeMillis;
    yield* store.issue(
      InstanceToken.make({
        id: TokenId.make("existing-browser"),
        memberId: alice.id,
        name: TokenName.make("Browser"),
        hash: secretHash("existing-browser-secret"),
        scopes: RoleBinding.make({ ...binding, role: "viewer" }).permissions,
        kind: "session",
        createdAt: now,
        lastUsedAt: now,
        expiresAt: now + 60000,
      }),
    );
    assert.isTrue(
      permits((yield* auth.authenticate("existing-browser-secret")).permissions, "operate", alpha),
    );
  }).pipe(Effect.scoped),
);

it.live("removes access from an existing browser session when its binding is removed", () =>
  Effect.gen(function* () {
    const alpha = ProjectScope.make({ project: ProjectId.make("alpha") });
    let grants: ReadonlyArray<PermissionGrant> = RoleBinding.make({
      name: "alice-alpha",
      member: alice.id,
      role: "operator",
      scope: alpha,
    }).permissions;
    const { authentication: auth } = yield* authFixture([alice], alice, () => grants);
    const currentLink = yield* auth.link;
    const link = new URL(currentLink);
    const session = yield* auth.consumeLink(
      new URLSearchParams(link.hash.slice(1)).get("link") ?? "",
    );
    const secret = Redacted.value(session.secret);
    assert.isTrue(permits((yield* auth.authenticate(secret)).permissions, "operate", alpha));
    grants = [];
    assert.deepEqual((yield* auth.authenticate(secret)).permissions, []);
  }).pipe(Effect.scoped),
);

it.live("keeps device sign-in scopes at the current binding snapshot after a promotion", () =>
  Effect.gen(function* () {
    const alpha = ProjectScope.make({ project: ProjectId.make("alpha") });
    const binding = RoleBinding.make({
      name: "alice-alpha",
      member: alice.id,
      role: "viewer",
      scope: alpha,
    });
    let grants: ReadonlyArray<PermissionGrant> = binding.permissions;
    const { authentication: auth } = yield* authFixture([alice], alice, () => grants);
    const started = yield* auth.startDevice(TokenName.make("Laptop"));
    yield* TestClock.adjust("1 second");
    const issued = yield* auth.pollDevice(Redacted.value(started.id));
    assert.isTrue(Option.isSome(issued));
    if (Option.isNone(issued)) return;
    const secret = Redacted.value(issued.value.secret);
    grants = RoleBinding.make({ ...binding, role: "operator" }).permissions;
    const access = yield* auth.authenticate(secret);
    assert.isTrue(permits(access.permissions, "read", alpha));
    assert.isFalse(permits(access.permissions, "operate", alpha));
    grants = [];
    assert.deepEqual((yield* auth.authenticate(secret)).permissions, []);
  }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
);

it.live("keeps, replaces, and removes a device token's operation ceiling", () =>
  Effect.gen(function* () {
    const services = yield* authFixture();
    const auth = services.authentication;
    const secret = yield* browserSession(auth);
    const approve = [OperationId.make("operator.approve")];
    const issued = yield* auth.createToken(
      secret,
      deviceToken("Approver", administratorPermissions, Option.some(approve)),
    );
    const device = Redacted.value(issued.secret);
    assert.deepEqual((yield* auth.authenticate(device)).operations, Option.some(approve));
    assert.isTrue(Option.isNone((yield* auth.authenticate(secret)).operations));
    const token = (yield* services.store.tokens(alice.id)).find(({ kind }) => kind === "device");
    assert.isDefined(token);
    if (token === undefined) return;
    yield* auth.setScopes(
      secret,
      token.id,
      administratorPermissions,
      OperationCeilingChange.Keep(),
    );
    assert.deepEqual((yield* auth.authenticate(device)).operations, Option.some(approve));
    const overview = OperationId.make("operator.overview");
    const read = [overview, OperationId.make("operator.detail")];
    yield* auth.setScopes(
      secret,
      token.id,
      administratorPermissions,
      OperationCeilingChange.Replace({ operations: read }),
    );
    assert.deepEqual((yield* auth.authenticate(device)).operations, Option.some(read));
    const narrower = yield* auth.createToken(
      device,
      deviceToken("Narrower", administratorPermissions, Option.some([overview])),
    );
    assert.deepEqual(
      (yield* auth.authenticate(Redacted.value(narrower.secret))).operations,
      Option.some([overview]),
    );
    const wider = yield* auth
      .createToken(device, deviceToken("Wider", administratorPermissions, Option.some(approve)))
      .pipe(Effect.flip);
    assert.equal(wider.status, 403);
    const unbounded = yield* auth
      .createToken(device, deviceToken("Unbounded", administratorPermissions))
      .pipe(Effect.flip);
    assert.equal(unbounded.status, 403);
    yield* auth.setScopes(
      secret,
      token.id,
      administratorPermissions,
      OperationCeilingChange.Remove(),
    );
    assert.isTrue(Option.isNone((yield* auth.authenticate(device)).operations));
  }).pipe(Effect.scoped),
);

it.live("keeps a ceiling that another edit narrows while a scope-only edit runs", () =>
  Effect.gen(function* () {
    const overview = OperationId.make("operator.overview");
    const both = [overview, OperationId.make("operator.approve")];
    // Runs once, after setScopes reads the token list and before it writes.
    let interleave: Effect.Effect<void, AuthError> = Effect.void;
    const services = yield* authFixture([alice], alice, undefined, (store) => ({
      ...store,
      tokens: (id) =>
        store.tokens(id).pipe(
          Effect.tap(() => {
            const pending = interleave;
            interleave = Effect.void;
            return pending;
          }),
        ),
    }));
    const auth = services.authentication;
    const secret = yield* browserSession(auth);
    const issued = yield* auth.createToken(
      secret,
      deviceToken("Reader", administratorPermissions, Option.some(both)),
    );
    const token = (yield* services.store.tokens(alice.id)).find(({ kind }) => kind === "device");
    assert.isDefined(token);
    if (token === undefined) return;
    interleave = services.store.setScopes(
      alice.id,
      token.id,
      administratorPermissions,
      OperationCeilingChange.Replace({ operations: [overview] }),
    );
    yield* auth.setScopes(
      secret,
      token.id,
      administratorPermissions,
      OperationCeilingChange.Keep(),
    );
    assert.deepEqual(
      (yield* auth.authenticate(Redacted.value(issued.secret))).operations,
      Option.some([overview]),
    );
  }).pipe(Effect.scoped),
);

it.effect("expires a device token at the expiry set at creation", () =>
  Effect.gen(function* () {
    const services = yield* authFixture();
    const auth = services.authentication;
    const secret = yield* browserSession(auth);
    const now = yield* Clock.currentTimeMillis;
    const past = yield* auth
      .createToken(
        secret,
        deviceToken("Past", administratorPermissions, Option.none(), Option.some(now)),
      )
      .pipe(Effect.flip);
    assert.equal(past.status, 400);
    const issued = yield* auth.createToken(
      secret,
      deviceToken("Hour", administratorPermissions, Option.none(), Option.some(now + 3_600_000)),
    );
    const device = Redacted.value(issued.secret);
    const token = (yield* services.store.tokens(alice.id)).find(({ kind }) => kind === "device");
    assert.equal(token?.expiresAt, now + 3_600_000);
    assert.isTrue(Option.isSome((yield* auth.authenticate(device)).member));
    yield* TestClock.adjust("1 hour");
    assert.equal((yield* auth.authenticate(device).pipe(Effect.flip)).status, 401);
  }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
);
