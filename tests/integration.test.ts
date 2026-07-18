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
      components: { callout: "./src/components/Callout.astro" },
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
});
