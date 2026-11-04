import { RequestPermissions, RoleBinding, GitHubUserId, ProjectScope } from "@usine/core/access";
import { ProjectId } from "@usine/core/project";
import { Effect, Layer, Schema } from "effect";
import { expect, it } from "vitest";
import { harness, loopText } from "./support.ts";

for (const role of ["viewer", "operator", "maintainer"] as const)
  it(`${role} can only read and edit its authorized configuration`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const grants = RoleBinding.make({
          name: role,
          member: GitHubUserId.make(1),
          role,
          scope: ProjectScope.make({ project: ProjectId.make("acme-project") }),
        }).permissions;
        const { request } = yield* harness(Layer.succeed(RequestPermissions, grants));
        const response = yield* request("GET", "");
        expect(response).toMatchObject({
          status: 200,
          body: {
            projects: [{ id: "acme-project" }],
            repositories: [{ name: "acme/project" }],
            workers: [],
            bindings: [],
            loops: [{ name: "acme-project/implement" }],
            agents: [{ name: "developer", loops: ["acme-project/implement"] }],
          },
        });
        const own = yield* request("GET", "/entities/project/acme-project");
        expect(own.status).toBe(200);

        expect((yield* request("GET", "/entities/project/acme-other")).status).toBe(403);

        expect((yield* request("GET", "/entities/settings/instance")).status).toBe(403);

        expect((yield* request("GET", "/revisions/1")).status).toBe(403);
        const currentResponse = yield* request("GET", "/revisions");
        expect(currentResponse).toMatchObject({
          status: 200,
          body: { revisions: [] },
        });
        const { value } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ value: Schema.JsonObject }),
        )(own.body);

        expect(
          (yield* request("PUT", "/entities/project/acme-project", {
            expected: 1,
            value: { ...value, name: "Renamed" },
          })).status,
        ).toBe(403);
        const decodedValue5 = yield* request("DELETE", "/entities/project/acme-project", {
          expected: 1,
        });
        expect(decodedValue5.status).toBe(403);

        expect(
          (yield* request("PUT", "/entities/binding/escalate", {
            expected: 1,
            value: { name: "escalate", member: 1, role: "admin", scope: { _tag: "Instance" } },
          })).status,
        ).toBe(403);

        expect(
          (yield* request("PUT", "/entities/loop/acme-project%2Fimplement", {
            expected: 1,
            text: loopText.replace("Implement.", "Implement carefully."),
          })).status,
        ).toBe(role === "maintainer" ? 200 : 403);
        if (role === "maintainer") {
          expect(
            (yield* request("PUT", "/entities/project/acme-project", {
              expected: 2,
              value: { ...value, lanes: [{ name: "Ready", sources: [{ label: "ready" }] }] },
            })).status,
          ).toBe(200);
          const nextResponse = yield* request("GET", "/revisions");
          expect(nextResponse).toMatchObject({
            status: 200,
            body: { revisions: [{ number: 3 }, { number: 2 }] },
          });
        }
      }).pipe(Effect.scoped),
    ));

for (const role of ["viewer", "operator", "maintainer"] as const)
  it(`${role} cannot read another project's nested agent loop references`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const grants = RoleBinding.make({
          name: role,
          member: GitHubUserId.make(1),
          role,
          scope: ProjectScope.make({ project: ProjectId.make("acme-other") }),
        }).permissions;
        const { request } = yield* harness(Layer.succeed(RequestPermissions, grants));
        const response = yield* request("GET", "");
        expect(response).toMatchObject({
          status: 200,
          body: {
            projects: [{ id: "acme-other" }],
            loops: [],
            agents: [{ name: "developer", loops: [] }],
          },
        });
      }).pipe(Effect.scoped),
    ));
