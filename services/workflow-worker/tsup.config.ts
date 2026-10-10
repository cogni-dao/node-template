import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  clean: true,
  target: "node22",
  noExternal: ["@cogni-dao/agent-workflow-runtime"],
});
