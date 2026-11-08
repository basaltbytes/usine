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
      oneOf: [{ ...variant("PlanItem", "plan"), properties: { type } }],
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
      Item: { anyOf: [{ allOf: [ref("Alias")] }] },
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
});
