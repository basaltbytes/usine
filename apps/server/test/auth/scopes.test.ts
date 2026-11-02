import { assert, it } from "vitest";
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
import { InstanceToken, TokenId, TokenName } from "../../src/auth/model.ts";
import { secretHash } from "../../src/auth/crypto.ts";

it("keeps local attribution separate from members and limits issued tokens to current grants", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const alpha = new ProjectScope({ project: ProjectId.make("alpha") });
      const beta = new ProjectScope({ project: ProjectId.make("beta") });
      let grants: ReadonlyArray<PermissionGrant> = new RoleBinding({
        name: "alice-alpha",
        member: alice.id,
        role: "maintainer",
        scope: alpha,
      }).permissions;
      const services = yield* authFixture([alice], alice, () => grants);
      const auth = services.authentication;
      const local = yield* auth.authenticate(localSecret);
      assert.isTrue(Option.isNone(local.member));
      const url = new URL(yield* auth.link);
      const session = yield* auth.consumeLink(
        new URLSearchParams(url.hash.slice(1)).get("link") ?? "",
      );
      const secret = Redacted.value(session.secret);
      const refused = yield* auth
        .createToken(secret, TokenName.make("Too wide"), administratorPermissions)
        .pipe(Effect.flip);
      assert.equal(refused.status, 403);
      const issued = yield* auth.createToken(secret, TokenName.make("Read alpha"), [
        new PermissionGrant({ permission: "read", scope: alpha }),
      ]);
      const access = yield* auth.authenticate(Redacted.value(issued.secret));
      assert.isTrue(permits(access.permissions, "read", alpha));
      assert.isFalse(permits(access.permissions, "read", beta));
      assert.isFalse(permits(access.permissions, "operate", alpha));
      const tokens = yield* services.store.tokens(alice.id);
      const device = tokens.find(({ kind }) => kind === "device");
      assert.isDefined(device);
      if (device === undefined) return;
      yield* auth.setScopes(secret, device.id, grants);
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
  ));

for (const initialRole of ["none", "viewer"] as const)
  it(`updates the same browser session when a ${initialRole} member gains an operator binding`, async () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const alpha = new ProjectScope({ project: ProjectId.make("alpha") });
        const binding = new RoleBinding({
          name: "alice-alpha",
          member: alice.id,
          role: "operator",
          scope: alpha,
        });
        let grants: ReadonlyArray<PermissionGrant> =
          initialRole === "none" ? [] : new RoleBinding({ ...binding, role: "viewer" }).permissions;
        const { authentication: auth, store } = yield* authFixture([alice], alice, () => grants);
        const started = yield* auth.startWeb(false);
        const session = yield* auth.finishWeb(Redacted.value(started.state), "code");
        const secret = Redacted.value(session.secret);
        assert.isFalse(permits((yield* auth.authenticate(secret)).permissions, "operate", alpha));
        grants = binding.permissions;
        assert.isTrue(permits((yield* auth.authenticate(secret)).permissions, "operate", alpha));
        const device = yield* auth.createToken(secret, TokenName.make("Operator"), grants);
        assert.isTrue(
          permits(
            (yield* auth.authenticate(Redacted.value(device.secret))).permissions,
            "operate",
            alpha,
          ),
        );
        grants = new RoleBinding({ ...binding, role: "maintainer" }).permissions;
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
        assert.equal((yield* auth.setScopes(secret, browser.id, []).pipe(Effect.flip)).status, 400);
      }).pipe(Effect.scoped),
    ));

it("uses current bindings for a browser session with a stored scope ceiling", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const alpha = new ProjectScope({ project: ProjectId.make("alpha") });
      const binding = new RoleBinding({
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
        new InstanceToken({
          id: TokenId.make("existing-browser"),
          memberId: alice.id,
          name: TokenName.make("Browser"),
          hash: secretHash("existing-browser-secret"),
          scopes: new RoleBinding({ ...binding, role: "viewer" }).permissions,
          kind: "session",
          createdAt: now,
          lastUsedAt: now,
          expiresAt: now + 60_000,
        }),
      );
      assert.isTrue(
        permits(
          (yield* auth.authenticate("existing-browser-secret")).permissions,
          "operate",
          alpha,
        ),
      );
    }).pipe(Effect.scoped),
  ));

it("removes access from an existing browser session when its binding is removed", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const alpha = new ProjectScope({ project: ProjectId.make("alpha") });
      let grants: ReadonlyArray<PermissionGrant> = new RoleBinding({
        name: "alice-alpha",
        member: alice.id,
        role: "operator",
        scope: alpha,
      }).permissions;
      const { authentication: auth } = yield* authFixture([alice], alice, () => grants);
      const link = new URL(yield* auth.link);
      const session = yield* auth.consumeLink(
        new URLSearchParams(link.hash.slice(1)).get("link") ?? "",
      );
      const secret = Redacted.value(session.secret);
      assert.isTrue(permits((yield* auth.authenticate(secret)).permissions, "operate", alpha));
      grants = [];
      assert.deepEqual((yield* auth.authenticate(secret)).permissions, []);
    }).pipe(Effect.scoped),
  ));

it("keeps device sign-in scopes at the current binding snapshot after a promotion", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const alpha = new ProjectScope({ project: ProjectId.make("alpha") });
      const binding = new RoleBinding({
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
      grants = new RoleBinding({ ...binding, role: "operator" }).permissions;
      const access = yield* auth.authenticate(secret);
      assert.isTrue(permits(access.permissions, "read", alpha));
      assert.isFalse(permits(access.permissions, "operate", alpha));
      grants = [];
      assert.deepEqual((yield* auth.authenticate(secret)).permissions, []);
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  ));
