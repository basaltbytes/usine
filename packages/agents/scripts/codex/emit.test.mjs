import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { emitDeclarations } from "./emit.mjs";

const ref = (name) => ({ $ref: `#/definitions/v2/${name}` });
const tag = (value) => ({ enum: [value], type: "string" });
const variant = (title, type) => ({
  title,
  type: "object",
  properties: { type: tag(type), text: { type: "string" } },
  required: ["type", "text"],
});
/** Returns the schemas that `declarations` define, by export name. */
const compile = (declarations) =>
  new Function(
    "Schema",
    [...declarations]
      .map(([name, expression]) => `const ${name} = ${expression};`)
      .concat(`return { ${[...declarations.keys()].join(", ")} };`)
      .join("\n"),
  )(Schema);

describe("emitDeclarations", () => {
  it("rejects a variant title that names a definition emitted later", () => {
    const definitions = {
      Item: { oneOf: [variant("RateLimitWindow", "plan")] },
      Root: {
        type: "object",
        properties: { item: ref("Item"), window: ref("RateLimitWindow") },
        required: ["item", "window"],
      },
      RateLimitWindow: {
        type: "object",
        properties: { usedPercent: { type: "integer" } },
        required: ["usedPercent"],
      },
    };
    expect(() => emitDeclarations(definitions, ["Root"])).toThrow(
      "Two schemas share the export name RateLimitWindow",
    );
  });

  it("rejects a variant title that names a definition emitted earlier", () => {
    const definitions = {
      Plan: { type: "object", properties: { text: { type: "string" } } },
      Item: { oneOf: [variant("Plan", "plan")] },
    };
    expect(() => emitDeclarations(definitions, ["Plan", "Item"])).toThrow(
      "Two schemas share the export name Plan",
    );
  });

  it("rejects enums whose type also allows other values", () => {
    const definitions = { Status: { enum: ["active"], type: ["string", "null"] } };
    expect(() => emitDeclarations(definitions, ["Status"])).toThrow(
      'Enums of type ["string","null"] need explicit support',
    );
  });

  it("rejects const schemas", () => {
    const definitions = {
      Item: { type: "object", properties: { type: { const: "plan", type: "string" } } },
    };
    expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
      "const schemas need explicit support",
    );
  });

  it("rejects variant type tags that are not inline single-value enums", () => {
    const wrapped = (type) => ({
      oneOf: [
        { ...variant("PlanItem", "plan"), properties: { type } },
        variant("OtherItem", "other"),
      ],
    });
    for (const type of [
      ref("PlanType"),
      { allOf: [ref("PlanType")] },
      { type: "string" },
      { enum: ["plan", "draft"], type: "string" },
    ]) {
      const definitions = { Item: wrapped(type), PlanType: tag("plan") };
      expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
        "Variant PlanItem needs an inline single-value type tag",
      );
    }
  });

  it("validates referenced variant tags even when the definition was already emitted", () => {
    for (const type of [
      ref("PlanType"),
      { allOf: [ref("PlanType")] },
      { type: "string" },
      { enum: ["plan", "draft"], type: "string" },
    ]) {
      const definitions = {
        Item: { oneOf: [ref("PlanItem"), variant("OtherItem", "other")] },
        PlanItem: { ...variant("PlanItem", "plan"), properties: { type } },
        PlanType: tag("plan"),
      };
      for (const roots of [["Item"], ["PlanItem", "Item"]]) {
        expect(() => emitDeclarations(definitions, roots)).toThrow(
          "Variant PlanItem needs an inline single-value type tag",
        );
      }
    }
  });

  it("validates variant tags through reference and allOf wrappers", () => {
    const definitions = {
      Item: { anyOf: [{ allOf: [ref("Alias")] }, variant("OtherItem", "other")] },
      Alias: ref("PlanItem"),
      PlanItem: { ...variant("PlanItem", "plan"), properties: { type: { type: "string" } } },
    };
    expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
      "Variant PlanItem needs an inline single-value type tag",
    );
  });

  it("keeps referenced variants with literal tags or no tag", () => {
    const definitions = {
      Item: { oneOf: [ref("PlanItem"), ref("TextItem")] },
      PlanItem: variant("PlanItem", "plan"),
      TextItem: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    };
    const declarations = emitDeclarations(definitions, ["PlanItem", "Item"]);
    expect(declarations.get("Item")).toBe("Schema.Union([PlanItem, TextItem])");
    expect(declarations.get("PlanItem")).toContain('"type": Schema.Literal("plan")');
    expect(declarations.get("TextItem")).toBe('Schema.Struct({"text": Schema.String})');
  });

  it.each(["oneOf", "anyOf"])(
    "keeps %s nullable objects with an ordinary type field",
    (keyword) => {
      for (const type of [{ type: "string" }, ref("Kind")]) {
        for (const branches of [
          [ref("Attachment"), { type: "null" }],
          [{ type: "null" }, ref("Attachment")],
        ]) {
          const definitions = {
            Root: { [keyword]: branches },
            Attachment: { type: "object", properties: { type }, required: ["type"] },
            Kind: { enum: ["a", "b"], type: "string" },
          };
          const declarations = emitDeclarations(definitions, ["Root"]);
          expect(declarations.get("Root")).toBe(
            branches[0].$ref
              ? "Schema.Union([Attachment, Schema.Null])"
              : "Schema.Union([Schema.Null, Attachment])",
          );
          expect(declarations.get("Attachment")).toBe(
            `Schema.Struct({"type": ${type.$ref ? "Kind" : "Schema.String"}})`,
          );
        }
      }
    },
  );

  it("still validates tagged variants when a union also allows null", () => {
    const definitions = {
      Item: { anyOf: [ref("PlanItem"), variant("OtherItem", "other"), { type: "null" }] },
      PlanItem: { ...variant("PlanItem", "plan"), properties: { type: { type: "string" } } },
    };
    expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
      "Variant PlanItem needs an inline single-value type tag",
    );
  });

  it("rejects open tags inherited by inline union variants", () => {
    for (const keyword of ["oneOf", "anyOf"]) {
      const definitions = {
        Item: {
          type: "object",
          properties: { type: { type: "string" }, id: { type: "string" } },
          required: ["type", "id"],
          [keyword]: [
            {
              title: "A",
              type: "object",
              properties: { a: { type: "string" } },
              required: ["a"],
            },
            {
              title: "B",
              type: "object",
              properties: { type: tag("b"), b: { type: "string" } },
              required: ["b"],
            },
          ],
        },
      };
      expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
        "Variant A needs an inline single-value type tag",
      );
    }
  });

  it("keeps open fields shared by variants that their required fields tell apart", () => {
    const definitions = {
      Item: {
        type: "object",
        properties: { type: { type: "string" }, id: { type: "string" } },
        required: ["type", "id"],
        oneOf: [
          { title: "A", type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { title: "B", type: "object", properties: { b: { type: "string" } }, required: ["b"] },
        ],
      },
    };
    const { Item } = compile(emitDeclarations(definitions, ["Item"]));
    expect(Schema.decodeUnknownSync(Item)({ type: "x", id: "1", b: "kept" })).toEqual({
      type: "x",
      id: "1",
      b: "kept",
    });
  });

  it("rejects reference wrappers with sibling constraints", () => {
    for (const wrapper of [ref("PlanItem"), { allOf: [ref("PlanItem")] }]) {
      for (const sibling of [
        { properties: { type: tag("plan") } },
        { required: ["type"] },
        { type: "object" },
        { anyOf: [variant("OtherItem", "other")] },
      ]) {
        const definitions = {
          Item: { oneOf: [{ title: "WrappedItem", ...wrapper, ...sibling }] },
          PlanItem: variant("PlanItem", "plan"),
        };
        expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
          "Wrapper sibling constraints need explicit support",
        );
      }
    }
  });

  it("rejects common union fields that would be lost through a reference branch", () => {
    for (const branch of [ref("PlanItem"), { allOf: [ref("PlanItem")] }]) {
      const definitions = {
        Item: {
          type: "object",
          properties: { id: { type: "string" }, type: tag("plan") },
          required: ["id", "type"],
          oneOf: [branch],
        },
        PlanItem: variant("PlanItem", "plan"),
      };
      expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
        "Wrapper sibling constraints need explicit support",
      );
    }
  });

  it("rejects simultaneous oneOf and anyOf constraints", () => {
    const definitions = {
      Item: {
        oneOf: [variant("PlanItem", "plan")],
        anyOf: [variant("OtherItem", "other")],
      },
    };
    expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
      "Simultaneous oneOf and anyOf need explicit support",
    );
  });

  it("keeps reference wrappers with annotation siblings", () => {
    for (const wrapper of [ref("PlanItem"), { allOf: [ref("PlanItem")] }]) {
      const definitions = {
        Item: {
          oneOf: [{ ...wrapper, title: "WrappedItem", description: "A plan", default: {} }],
        },
        PlanItem: variant("PlanItem", "plan"),
      };
      const declarations = emitDeclarations(definitions, ["Item"]);
      expect(declarations.get("Item")).toBe("PlanItem");
      expect(declarations.get("PlanItem")).toContain('"type": Schema.Literal("plan")');
    }
  });

  it("keeps the parent's required fields on merged variants", () => {
    const definitions = {
      Item: {
        oneOf: [
          {
            title: "ImageItem",
            type: "object",
            properties: { type: tag("image"), id: { type: "string" } },
            required: ["id", "type"],
            anyOf: [
              {
                title: "FileImageItem",
                type: "object",
                properties: { fileId: { type: "string" } },
                required: ["fileId"],
              },
            ],
          },
        ],
      },
    };
    const declarations = emitDeclarations(definitions, ["Item"]);
    expect(declarations.get("FileImageItem")).toBe(
      'Schema.Struct({"type": Schema.Literal("image"),\n"id": Schema.String,\n"fileId": Schema.String})',
    );
  });

  it("lists the string members of a union that mixes enums and objects", () => {
    const definitions = {
      ErrorInfo: {
        anyOf: [
          { enum: ["serverOverloaded", "other"], type: "string" },
          {
            title: "HttpErrorInfo",
            type: "object",
            properties: { status: { type: "integer" } },
            required: ["status"],
          },
        ],
      },
    };
    expect(emitDeclarations(definitions, ["ErrorInfo"]).get("ErrorInfoValues")).toBe(
      '["serverOverloaded","other"] as const',
    );
  });
  it("tags union variants on keys other than type", () => {
    const kind = (value, properties = {}, required = []) => ({
      type: "object",
      properties: { kind: tag(value), ...properties },
      required: ["kind", ...required],
    });
    const definitions = {
      SpecialPath: {
        oneOf: [
          { title: "RootPath", ...kind("root") },
          kind("unknown", { path: { type: "string" } }, ["path"]),
        ],
      },
    };
    const declarations = emitDeclarations(definitions, ["SpecialPath"]);
    expect(declarations.get("RootPath")).toBe('Schema.Struct({"kind": Schema.Literal("root")})');
    const { SpecialPath } = compile(declarations);
    expect(Schema.decodeUnknownSync(SpecialPath)({ kind: "unknown", path: "/x" })).toEqual({
      kind: "unknown",
      path: "/x",
    });
    expect(Schema.is(SpecialPath)({ kind: "future" })).toBe(false);
  });

  it("rejects open tags on keys other than type", () => {
    const definitions = {
      Hook: {
        oneOf: [
          {
            title: "CommandHook",
            type: "object",
            properties: { handlerType: tag("command"), command: { type: "string" } },
            required: ["handlerType", "command"],
          },
          {
            title: "PromptHook",
            type: "object",
            properties: { handlerType: { type: "string" } },
            required: ["handlerType"],
          },
        ],
      },
    };
    expect(() => emitDeclarations(definitions, ["Hook"])).toThrow(
      "Variant PromptHook needs an inline single-value handlerType tag",
    );
  });

  it("rejects union tags that are not required", () => {
    const definitions = {
      Item: {
        oneOf: [
          { ...variant("PlanItem", "plan"), required: ["text"] },
          variant("OtherItem", "other"),
        ],
      },
    };
    expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
      "Variant PlanItem needs a required type tag",
    );
  });

  it("rejects variants that an earlier variant would decode", () => {
    const untagged = {
      title: "TextItem",
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    };
    for (const [alternatives, message] of [
      [
        [variant("PlanItem", "plan"), variant("DraftItem", "plan")],
        "Variant PlanItem accepts the values of variant DraftItem; they need distinct tags",
      ],
      [
        [untagged, variant("PlanItem", "plan")],
        "Variant TextItem accepts the values of variant PlanItem; they need distinct tags",
      ],
      [
        [
          untagged,
          {
            title: "PlanItem",
            type: "object",
            properties: { type: tag("plan"), text: { type: "string" } },
            required: ["type"],
          },
        ],
        "Variant TextItem accepts the values of variant PlanItem; they need distinct tags",
      ],
      ...[
        { type: "object" },
        { type: "object", properties: {} },
        { type: "object", additionalProperties: { type: "string" } },
        { type: "object", additionalProperties: true },
      ].map((bag) => [
        [untagged, { title: "BagItem", ...bag }],
        "Variant TextItem accepts the values of variant BagItem; they need distinct tags",
      ]),
    ]) {
      const definitions = { Item: { anyOf: alternatives } };
      expect(() => emitDeclarations(definitions, ["Item"])).toThrow(message);
    }
  });

  it("keeps variants that share a tag when their required fields tell them apart", () => {
    const definitions = {
      Image: {
        title: "Image",
        type: "object",
        properties: { type: tag("image"), id: { type: "string" } },
        required: ["type", "id"],
        anyOf: [
          {
            title: "FileImage",
            type: "object",
            properties: { fileId: { type: "string" } },
            required: ["fileId"],
          },
          {
            title: "InlineImage",
            type: "object",
            properties: { result: { type: "string" } },
            required: ["result"],
          },
        ],
      },
    };
    const { Image } = compile(emitDeclarations(definitions, ["Image"]));
    for (const payload of [{ fileId: "file" }, { result: "data" }]) {
      const image = { type: "image", id: "image", ...payload };
      expect(Schema.decodeUnknownSync(Image)(image)).toEqual(image);
    }
  });

  it("rejects union siblings that the variants would drop", () => {
    for (const siblings of [
      { required: ["text"] },
      { enum: ["plan"] },
      { type: "string", properties: { text: { type: "string" } } },
    ]) {
      const definitions = {
        Item: { oneOf: [variant("PlanItem", "plan"), variant("OtherItem", "other")], ...siblings },
      };
      expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
        "Union sibling constraints need explicit support",
      );
    }
  });

  it("rejects a null alternative beside common properties", () => {
    for (const alternative of [{ type: "null" }, { type: ["null"] }]) {
      const definitions = {
        Item: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          anyOf: [variant("PlanItem", "plan"), alternative],
        },
      };
      expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
        "A null alternative beside common properties needs explicit support",
      );
    }
  });

  it("compares the variants of a nested union with the variants beside it", () => {
    const tagged = (title, type, required) => ({
      title,
      type: "object",
      properties: { type: tag(type), x: { type: "string" } },
      required,
    });
    for (const definitions of [
      {
        Item: { anyOf: [ref("Inner"), tagged("BItem", "b", ["type", "x"])] },
        Inner: { oneOf: [tagged("AItem", "b", ["type"]), tagged("CItem", "c", ["type"])] },
      },
      {
        Item: { anyOf: [tagged("BItem", "b", ["type"]), ref("Inner")] },
        Inner: { oneOf: [tagged("AItem", "b", ["type", "x"]), tagged("CItem", "c", ["type"])] },
      },
    ]) {
      expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
        /Variant [AB]Item accepts the values of variant [AB]Item/u,
      );
    }
  });

  it("keeps a nested union whose variants the outer variants tell apart", () => {
    const definitions = {
      Item: { anyOf: [ref("Inner"), variant("BItem", "b"), { type: "string" }] },
      Inner: { oneOf: [variant("AItem", "a"), variant("CItem", "c")] },
    };
    expect(emitDeclarations(definitions, ["Item"]).get("Item")).toBe(
      "Schema.Union([Inner, BItem, Schema.String])",
    );
  });

  it("rejects a union that contains itself", () => {
    const definitions = { Item: { anyOf: [ref("Item"), variant("BItem", "b")] } };
    expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
      "Recursive union needs explicit support",
    );
  });

  it("keeps null alternatives written as a type list", () => {
    const definitions = {
      Root: { anyOf: [ref("Attachment"), { type: ["null"] }] },
      Attachment: {
        type: "object",
        properties: { type: { type: "string" } },
        required: ["type"],
      },
    };
    expect(emitDeclarations(definitions, ["Root"]).get("Root")).toBe(
      "Schema.Union([Attachment, Schema.Null])",
    );
  });

  it("keeps a single-variant union whose object has an ordinary type field", () => {
    const definitions = {
      Root: {
        oneOf: [
          {
            title: "Attachment",
            type: "object",
            properties: { type: { type: "string" } },
            required: ["type"],
          },
        ],
      },
    };
    expect(emitDeclarations(definitions, ["Root"]).get("Attachment")).toBe(
      'Schema.Struct({"type": Schema.String})',
    );
  });

  it("rejects variant wrappers that refer to each other", () => {
    const definitions = {
      Item: { oneOf: [ref("Alias"), variant("OtherItem", "other")] },
      Alias: ref("Other"),
      Other: { allOf: [ref("Alias")] },
    };
    expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
      "Recursive variant wrapper needs explicit support",
    );
  });

  it("rejects a definition named after another definition's enum values", () => {
    const definitions = {
      Status: { enum: ["active", "idle"], type: "string" },
      StatusValues: { type: "object", properties: { text: { type: "string" } } },
    };
    for (const roots of [
      ["Status", "StatusValues"],
      ["StatusValues", "Status"],
    ]) {
      expect(() => emitDeclarations(definitions, roots)).toThrow(
        "Two schemas share the export name StatusValues",
      );
    }
  });

  it("keeps enums without a type as open strings", () => {
    const declarations = emitDeclarations({ Mode: { enum: ["fast", "slow"] } }, ["Mode"]);
    expect(declarations.get("Mode")).toBe("Schema.String");
    expect(declarations.get("ModeValues")).toBe('["fast","slow"] as const');
  });

  it("lists the members of referenced enum alternatives", () => {
    const definitions = {
      ErrorInfo: { anyOf: [{ enum: ["serverOverloaded"], type: "string" }, ref("ErrorCode")] },
      ErrorCode: { enum: ["other", "serverOverloaded"], type: "string" },
    };
    expect(emitDeclarations(definitions, ["ErrorInfo"]).get("ErrorInfoValues")).toBe(
      '["serverOverloaded","other"] as const',
    );
  });

  it("does not list enum members nested in an object alternative", () => {
    const definitions = {
      Code: {
        anyOf: [
          { enum: ["a", "b"], type: "string" },
          {
            title: "DetailedCode",
            type: "object",
            properties: { detail: { type: "string" } },
            required: ["detail"],
            anyOf: [
              {
                title: "NamedCode",
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
              { enum: ["nested"], type: "string" },
            ],
          },
        ],
      },
    };
    expect(emitDeclarations(definitions, ["Code"]).get("CodeValues")).toBe('["a","b"] as const');
  });
});
