import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/satteri.ts", "src/runtime.ts"],
  dts: {
    tsgo: true,
  },
  exports: true,
  platform: "node",
});
