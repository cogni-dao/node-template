import { defineConfig } from "tsup";
export default defineConfig({ entry: ["src/index.ts"], format: ["esm"], clean: false, dts: { only: true, compilerOptions: { composite: false, incremental: false }, resolve: ["@cogni/ai-core"] } });
