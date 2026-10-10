import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    schedule: "src/schedule.ts",
    worker: "src/worker.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: "node22",
});
