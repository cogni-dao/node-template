import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // Declarations come from the workspace `tsc -b` pass.
  dts: false,
  sourcemap: true,
  clean: true,
  target: "node22",
});
