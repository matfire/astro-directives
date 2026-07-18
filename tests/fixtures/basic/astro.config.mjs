import { defineConfig } from "astro/config";
import { satteri } from "@astrojs/markdown-satteri";

import astroDirectives from "../../../src/index.ts";

export default defineConfig({
  markdown: {
    processor: satteri({
      features: { directive: true },
    }),
  },
  integrations: [
    astroDirectives({
      components: {
        callout: "./src/components/Callout.astro",
        badge: "./src/components/Badge.astro",
        youtube: "./src/components/Youtube.astro",
        unused: "./src/components/Unused.astro",
      },
    }),
  ],
});
