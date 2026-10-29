import { Effect, Option } from "effect";
import { assert, it } from "vitest";
import { seedOperator } from "../../src/auth/authentication.ts";
import { GitHubSignIn } from "../../src/auth/github.ts";
import { AuthStore } from "../../src/auth/store.ts";
import { alice, authFixture, bob } from "./fixture.ts";

it("enrolls the existing operator once without looking up GitHub on later starts", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* authFixture([]);
      const seed = (login: typeof alice.login | undefined) =>
        seedOperator(Option.fromUndefinedOr(login)).pipe(
          Effect.provideService(AuthStore, services.store),
          Effect.provideService(GitHubSignIn, services.github),
        );
      yield* seed(undefined);
      assert.deepEqual(yield* services.store.members, []);
      yield* seed(alice.login);
      const members = yield* services.store.members;
      assert.equal(members.length, 1);
      assert.equal(members[0]?.id, alice.id);
      assert.equal(members[0]?.addedBy, alice.login);
      yield* seed(bob.login);
      assert.deepEqual(yield* services.store.members, members);
      assert.deepEqual(services.seen, ["https://api.github.com/users/alice"]);
    }).pipe(Effect.scoped),
  ));
