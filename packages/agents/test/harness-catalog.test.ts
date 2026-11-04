import { assert, describe, it } from "@effect/vitest";
import { Harness } from "@usine/core/agent/brain";
import { Option, Schema } from "effect";
import {
  catalog,
  HarnessCatalog,
  HarnessDescriptor,
  WorkerRequirements,
  workerImageInputs,
} from "../src/harness/catalog.ts";
import { pi } from "../src/harness/pi/descriptor.ts";
// Generated image inputs are checked against the source descriptors.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync } from "node:fs";

describe("harness catalog", () => {
  it("admits a new ID by registration while refusing unregistered and malformed IDs", () => {
    const added = HarnessDescriptor.make({
      ...pi,
      id: Harness.make("new-harness"),
      label: "New harness",
    });
    const extended = HarnessCatalog.make({ descriptors: [...catalog.descriptors, added] });
    const decode = Schema.decodeOption(extended.harness);
    assert(Option.isNone(Schema.decodeOption(catalog.harness)(added.id)));
    assert.deepStrictEqual(decode(added.id), Option.some(added.id));
    assert.deepStrictEqual(extended.get(added.id), Option.some(added));
    assert(Option.isNone(decode("unknown")));
    assert(Option.isNone(decode("not a harness ID")));
    assert(Option.isNone(extended.get(Harness.make("unknown"))));
  });

  it("rejects duplicate IDs so registration and lookup cannot disagree", () => {
    assert(Option.isNone(HarnessCatalog.makeOption({ descriptors: [pi, pi] })));
  });

  it("adds worker packages and tag versions by registration, excluding bundled harnesses", () => {
    const added = HarnessDescriptor.make({
      ...pi,
      id: Harness.make("new-harness"),
      worker: WorkerRequirements.make({
        ...pi.worker,
        install: [
          { name: "new-harness", version: "1.2.3" },
          { name: "its-helper", version: "4.5.6" },
        ],
      }),
    });
    const inputs = workerImageInputs(catalog);
    assert.deepStrictEqual(workerImageInputs(HarnessCatalog.make({ descriptors: [pi] })), {
      npmPackages: [],
      tag: "",
    });
    assert.deepStrictEqual(
      workerImageInputs(HarnessCatalog.make({ descriptors: [...catalog.descriptors, added] })),
      {
        npmPackages: [...inputs.npmPackages, "new-harness@1.2.3", "its-helper@4.5.6"],
        tag: `${inputs.tag}-new-harness-1.2.3-4.5.6`,
      },
    );
  });

  it("generates both Dockerfiles, cloud-init, and the published image tag from the descriptors", () => {
    const read = (path: string) =>
      readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
    const inputs = workerImageInputs(catalog);
    for (const file of ["infra/worker-image/Dockerfile", "packages/cloudflare/image/Dockerfile"]) {
      const dockerfile = read(file);
      assert.include(dockerfile, `ARG HARNESS_PACKAGES="${inputs.npmPackages.join(" ")}"`);
      assert.match(dockerfile, /^RUN npm install -g .*\$\{HARNESS_PACKAGES\}/mu);
    }
    const cloudInit = read("infra/hetzner/cloud-init.yaml");
    assert.match(cloudInit, /^\s+npm install -g pnpm@\S+ /mu);
    assert.strictEqual(
      /^\s+npm install -g pnpm@\S+ (.*)$/mu.exec(cloudInit)?.[1],
      inputs.npmPackages.join(" "),
    );
    assert.strictEqual(read("infra/worker-image/tag.txt"), `${inputs.tag}\n`);
  });
});
