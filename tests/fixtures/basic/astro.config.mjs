import { defineConfig } from "astro/config";
import { satteri } from "@astrojs/markdown-satteri";
import { defineMdastPlugin } from "satteri";

import astroDirectives from "../../../src/index.ts";

const externalDirective = defineMdastPlugin({
  name: "fixture-external-directive",
  textDirective(node, context) {
    if (node.name !== "external") return;
    context.setProperty(node, "data", {
      ...node.data,
      hName: "span",
      hProperties: { "data-external": "true" },
    });
  },
});

export default defineConfig({
  markdown: {
    processor: satteri({
      features: { directive: true },
      mdastPlugins: [externalDirective],
    }),
  },
  integrations: [
    astroDirectives({
      throwOnUnknownDirectives: false,
      components: {
        callout: "./src/components/Callout.astro",
        badge: "./src/components/Badge.astro",
        youtube: "./src/components/Youtube.astro",
        unused: "./src/components/Unused.astro",
      },
    }),
  ],
});
