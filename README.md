# @matfire/astro-directives

[![Open on npmx.dev](https://npmx.dev/api/registry/badge/version/@matfire/astro-directives)](https://npmx.dev/package/@matfire/astro-directives)
[![Open on npmx.dev](https://npmx.dev/api/registry/badge/license/@matfire/astro-directives)](https://npmx.dev/package/@matfire/astro-directives)

Use ordinary `.md` content collection entries with Sätteri directives backed by Astro components. Container, leaf, and text directive children are rendered as the component's default slot.

## Install

```sh
npm install @matfire/astro-directives
```

Astro 7.1 or newer is required. The package uses Astro's default Sätteri Markdown processor.

## Configure

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import { satteri } from "@astrojs/markdown-satteri";
import astroDirectives from "@matfire/astro-directives";

export default defineConfig({
  markdown: {
    processor: satteri({
      features: { directive: true },
    }),
  },
  integrations: [
    astroDirectives({
      // throwOnUnknownDirectives: false, // Leave unknown directives untouched.
      components: {
        callout: {
          component: "./src/components/Callout.astro",
          type: "container",
        },
        youtube: {
          component: "./src/components/Youtube.astro",
          type: "leaf",
        },
        badge: {
          component: "./src/components/Badge.astro",
          type: "text",
        },
      },
    }),
  ],
});
```

The integration validates this setting but does not modify the configured Markdown processor. Existing Sätteri plugins and features remain under your control.

Relative component paths resolve from the Astro project root. Absolute paths, `URL` values, and package specifiers are passed through.

Each component must declare the one directive form it accepts:

- `type: "container"` for `:::name` directives with a closing `:::`
- `type: "leaf"` for `::name` directives
- `type: "text"` for inline `:name[label]` directives

Using a registered name with a different form fails the build with its Markdown location.

Use the registered names in content collection Markdown:

```md
:::callout{type="warning" #permissions .wide}
This **Markdown** becomes the component's default slot.
:::

::youtube{id="dQw4w9WgXcQ"}

Text with an :badge[inline component]{tone="positive"}.
```

Attribute values remain strings. Bare attributes become `true`, and `{#id}` / `{.class}` shorthand is passed as `id` / `class` props.

Unregistered directive names fail the build with their Markdown location by default. Set `throwOnUnknownDirectives: false` to leave unknown directive nodes untouched. This integration does not render unknown directives itself.

This initial release supports deferred `.md` content collection rendering. Markdown pages and direct `.md` imports are not part of the supported API.

## Standalone Sätteri plugin

The directive-to-sentinel plugin is available separately for custom Sätteri pipelines:

```js
import { markdownToHtml } from "satteri";
import createAstroDirectivesPlugin from "@matfire/astro-directives/satteri";

const result = await markdownToHtml(source, {
  features: { directive: true },
  mdastPlugins: [
    createAstroDirectivesPlugin({
      directives: {
        callout: "container",
        youtube: "leaf",
        badge: "text",
      },
      throwOnUnknownDirectives: false,
    }),
  ],
});
```

The emitted elements are internal transport markers intended for the main Astro integration to consume.
