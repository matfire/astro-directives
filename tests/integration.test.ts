import { satteri } from "@astrojs/markdown-satteri";
import { describe, expect, test, vi } from "vitest";

import { astroDirectives } from "../src/index.js";

type SetupHook = (params: Record<string, unknown>) => unknown;

describe("Astro integration configuration", () => {
  test("leaves the configured Sätteri processor untouched", () => {
    const existingPlugin = { name: "existing-plugin" };
    const processor = satteri({
      features: { directive: true, gfm: false },
      mdastPlugins: [existingPlugin],
    });
    const config = {
      root: new URL("file:///project/"),
      markdown: { processor },
    };
    const updateConfig = vi.fn<() => never>(() => {
      throw new Error("updateConfig must not be called");
    });
    const addContentEntryType = vi.fn<(entryType: unknown) => void>();
    const setup = astroDirectives({
      components: {
        callout: { component: "./src/components/Callout.astro", type: "container" },
      },
    }).hooks["astro:config:setup"] as SetupHook;

    setup({ config, updateConfig, addContentEntryType });

    expect(updateConfig).not.toHaveBeenCalled();
    expect(config.markdown.processor).toBe(processor);
    expect(processor.options).toEqual({
      features: { directive: true, gfm: false },
      mdastPlugins: [existingPlugin],
      hastPlugins: [],
    });
    expect(addContentEntryType).toHaveBeenCalledOnce();
  });

  test("asks the user to enable the directive feature", () => {
    const processor = satteri();
    const setup = astroDirectives({ components: {} }).hooks["astro:config:setup"] as SetupHook;

    expect(() =>
      setup({
        config: {
          root: new URL("file:///project/"),
          markdown: { processor },
        },
        addContentEntryType: vi.fn<(entryType: unknown) => void>(),
      }),
    ).toThrowError(/satteri\(\{ features: \{ directive: true \} \}\)/);
  });

  test("rejects a non-boolean unknown-directive option", () => {
    expect(() =>
      astroDirectives({
        components: {},
        throwOnUnknownDirectives: "no" as unknown as boolean,
      }),
    ).toThrowError(/throwOnUnknownDirectives must be a boolean/);
  });

  test("requires component descriptors", () => {
    expect(() =>
      astroDirectives({
        components: { callout: "./src/components/Callout.astro" as never },
      }),
    ).toThrowError(/must be an object with component and type properties/);
  });

  test("rejects invalid component imports", () => {
    expect(() =>
      astroDirectives({
        components: { callout: { component: "", type: "container" } },
      }),
    ).toThrowError(/must be a non-empty import string or URL/);
  });

  test("rejects invalid directive types", () => {
    expect(() =>
      astroDirectives({
        components: {
          callout: {
            component: "./src/components/Callout.astro",
            type: "block" as "container",
          },
        },
      }),
    ).toThrowError(/must have type "container", "leaf", or "text"/);
  });
});
