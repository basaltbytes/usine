import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ConfigurationEntityId, ConfigurationEntityKey } from "../src/configuration/model.ts";
import { parseConfigurationForm, validateConfigurationForm } from "../src/configuration/forms.ts";

it.effect(
  "preserves agent parent overrides through the form codec and rejects unknown fields",
  () =>
    Effect.gen(function* () {
      const key = new ConfigurationEntityKey({
        kind: "agent",
        identifier: ConfigurationEntityId.make("developer"),
      });
      const value = yield* parseConfigurationForm(
        key,
        "---\nharness: codex\nmodel: custom-model\neffort: high\nparent_model: parent-model\nparent_effort: low\n---\n# Persona\n",
      );
      expect(value).toMatchObject({
        parentModel: { _tag: "Some", value: "parent-model" },
        parentEffort: { _tag: "Some", value: "low" },
        persona: "# Persona\n",
      });
      expect(yield* validateConfigurationForm(key, value)).toEqual(value);
      const error = yield* validateConfigurationForm(key, { ...value, typo: true }).pipe(
        Effect.flip,
      );
      expect(error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ["typo"] })]),
      );
    }),
);

it.effect(
  "uses worker cross-field rules and rejects secret values instead of environment variable names",
  () =>
    Effect.gen(function* () {
      const key = new ConfigurationEntityKey({
        kind: "worker",
        identifier: ConfigurationEntityId.make("remote"),
      });
      const value = {
        name: "remote",
        kind: "ssh",
        destination: "host",
        root: "/work",
        gateway: {
          domain: "gateway.test",
          destination: "gateway",
          admin_token_env: "secret-token-value",
        },
      };
      const secret = yield* validateConfigurationForm(key, value).pipe(Effect.flip);
      expect(secret.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ["gateway", "admin_token_env"] })]),
      );
      const conflict = yield* validateConfigurationForm(key, {
        name: "remote",
        kind: "ssh",
        root: "/work",
      }).pipe(Effect.flip);
      expect(conflict.message).toContain("destination or a provisioner");
    }),
);

it.effect("rejects duplicate lane sources and settings typos with field paths", () =>
  Effect.gen(function* () {
    const repository = new ConfigurationEntityKey({
      kind: "repository",
      identifier: ConfigurationEntityId.make("acme/repo"),
    });
    const duplicate = yield* validateConfigurationForm(repository, {
      name: "acme/repo",
      lanes: [
        { name: "Ready", sources: [{ label: "ready" }] },
        { name: "Review", sources: [{ label: "READY" }] },
      ],
    }).pipe(Effect.flip);
    expect(duplicate.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["lanes"] })]),
    );
    const settings = new ConfigurationEntityKey({
      kind: "settings",
      identifier: ConfigurationEntityId.make("instance"),
    });
    const typo = yield* parseConfigurationForm(
      settings,
      "version: 1\nsettings: { poll_intervel: 30 }\n",
    ).pipe(Effect.flip);
    expect(typo.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["settings", "poll_intervel"] })]),
    );
  }),
);

it.effect(
  "accepts an empty project draft but requires repositories when saving and rejects unknown keys",
  () =>
    Effect.gen(function* () {
      const key = new ConfigurationEntityKey({
        kind: "project",
        identifier: ConfigurationEntityId.make("product"),
      });
      const draft = yield* parseConfigurationForm(
        key,
        "id: product\nname: Product\nrepositories: []\nlanes: []\n",
      );
      const empty = yield* validateConfigurationForm(key, draft).pipe(Effect.flip);
      expect(empty.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ["repositories", 0] })]),
      );
      const value = { ...draft, repositories: ["acme/api", "acme/web"] };
      expect(yield* validateConfigurationForm(key, value)).toEqual(value);
      const unknown = yield* parseConfigurationForm(
        key,
        "id: product\nname: Product\nrepositories: []\ntypo: true\n",
      ).pipe(Effect.flip);
      expect(unknown.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ["typo"] })]),
      );
    }),
);

it.effect("keeps repository tag edits from writing project lanes", () =>
  Effect.gen(function* () {
    const key = new ConfigurationEntityKey({
      kind: "repository",
      identifier: ConfigurationEntityId.make("acme/api"),
    });
    const draft = yield* parseConfigurationForm(
      key,
      "name: acme/api\ntags: [backend]\nlanes: [{ name: Ready, sources: [{ label: ready }] }]\n",
    );
    expect(draft).toEqual({ name: "acme/api", tags: ["backend"] });
  }),
);
