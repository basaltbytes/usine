import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  out: "./drizzle",
  schema: "./src/configuration/sqlite/schema.ts",
});
