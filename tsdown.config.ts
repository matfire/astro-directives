import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/satteri.ts"],
  dts: {
    tsgo: true,
  },
  exports: true,
  platform: "node",
});
