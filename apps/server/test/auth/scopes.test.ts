import { assert, it } from "vitest";
import { Effect, Option, Redacted } from "effect";
import {
  RoleBinding,
  ProjectScope,
  PermissionGrant,
  administratorPermissions,
  permits,
} from "@usine/core/access";
import { ProjectId } from "@usine/core/project";
import { alice, authFixture, localSecret } from "./fixture.ts";
import { TokenName } from "../../src/auth/model.ts";

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
      grants = [];
      assert.deepEqual((yield* auth.authenticate(Redacted.value(issued.secret))).permissions, []);
    }).pipe(Effect.scoped),
  ));
