import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    schedule: "src/schedule.ts",
    worker: "src/worker.ts",
  },
  format: ["esm"],
  // Declarations come from the workspace `tsc -b` pass. tsup's isolated dts
  // worker is incompatible with this repo's composite tsconfig.
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: "node22",
});
