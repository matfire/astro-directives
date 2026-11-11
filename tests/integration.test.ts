import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { satteri } from "@astrojs/markdown-satteri";
import { defineMdastPlugin } from "satteri";
import { describe, expect, test, vi } from "vitest";

import { astroDirectives } from "../src/index.js";

type SetupHook = (params: Record<string, unknown>) => unknown;

describe("Astro integration configuration", () => {
  test("leaves the configured Sätteri processor untouched", () => {
    const existingPlugin = defineMdastPlugin({ name: "existing-plugin", text() {} });
    const processor = satteri({
      features: { directive: true, gfm: false },
      mdastPlugins: [existingPlugin],
    });
    const config = {
      root: new URL("file:///project/"),
      markdown: { processor },
    };
    const updateConfig = vi.fn<(config: Record<string, unknown>) => void>();
    const addContentEntryType = vi.fn<(entryType: unknown) => void>();
    const setup = astroDirectives({
      components: {
        callout: { component: "./src/components/Callout.astro", type: "container" },
      },
    }).hooks["astro:config:setup"] as SetupHook;

    setup({ config, updateConfig, addContentEntryType });

    // The only config update is the content entry Vite plugin.
    expect(updateConfig).toHaveBeenCalledOnce();
    expect(Object.keys(updateConfig.mock.calls[0]![0])).toEqual(["vite"]);
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

describe("content entry render module", () => {
  const entryPath = resolve("tests/fixtures/basic/src/content/posts/post.md");
  const entryUrl = pathToFileURL(entryPath);
  const entryId = `${entryPath}?astroMarkdownContentEntry`;

  interface LoadHook {
    order: string;
    filter: { id: { include: RegExp; exclude: RegExp } };
    handler(this: { addWatchFile(file: string): void }, id: string): Promise<{ code: string }>;
  }
  type GetRenderModule = (params: {
    contents: string;
    fileUrl: URL;
    viteId: string;
  }) => Promise<{ code: string } | undefined>;

  function setupIntegration() {
    const config = {
      root: pathToFileURL(`${resolve("tests/fixtures/basic")}/`),
      image: {},
      markdown: { processor: satteri({ features: { directive: true } }) },
    };
    const updateConfig = vi.fn<(config: any) => void>();
    const addContentEntryType = vi.fn<(entryType: any) => void>();
    const { hooks } = astroDirectives({
      throwOnUnknownDirectives: false,
      components: {
        callout: { component: "./src/components/Callout.astro", type: "container" },
        badge: { component: "./src/components/Badge.astro", type: "text" },
        youtube: { component: "./src/components/Youtube.astro", type: "leaf" },
      },
    });
    (hooks["astro:config:setup"] as SetupHook)({ config, updateConfig, addContentEntryType });
    (hooks["astro:config:done"] as SetupHook)({ config });

    const plugin = updateConfig.mock.calls[0]![0].vite.plugins[0];
    return {
      plugin,
      load: plugin.load as LoadHook,
      getRenderModule: addContentEntryType.mock.calls[0]![0].getRenderModule as GetRenderModule,
      context: { addWatchFile: vi.fn<(file: string) => void>() },
    };
  }

  test("loads ahead of Astro's own Markdown plugin", () => {
    const { plugin, load } = setupIntegration();

    expect(plugin.enforce).toBe("pre");
    expect(load.order).toBe("pre");
  });

  test.each([
    ["a content entry", "?astroMarkdownContentEntry", true],
    ["a content entry with further params", "?t=1&astroMarkdownContentEntry=&x", true],
    ["a Markdown page or direct import", "", false],
    ["the propagated assets wrapper", "?astroPropagatedAssets", false],
    ["the render wrapper", "?astroRenderContent", false],
    ["a legacy content entry", "?astroContentCollectionEntry", false],
    ["a raw import", "?raw", false],
    ["a raw content entry import", "?astroMarkdownContentEntry&raw", false],
    ["a url import", "?url", false],
  ])("id filter for %s", (_label, query, expected) => {
    const { include, exclude } = setupIntegration().load.filter.id;
    const id = `/project/src/content/post.md${query}`;

    expect(include.test(id) && !exclude.test(id)).toBe(expected);
  });

  test("does not match other extensions", () => {
    const { include } = setupIntegration().load.filter.id;

    expect(include.test("/project/src/content/post.mdx?astroMarkdownContentEntry")).toBe(false);
    expect(include.test("/project/src/content/post.json?astroMarkdownContentEntry")).toBe(false);
  });

  test("renders a content entry from the load hook and watches its source", async () => {
    const { load, context } = setupIntegration();

    const module = await load.handler.call(context, entryId);

    expect(module.code).toContain('renderComponent(result, "callout"');
    expect(context.addWatchFile).toHaveBeenCalledWith(entryPath);
  });

  test("leaves Markdown pages and direct imports to Astro", async () => {
    const { getRenderModule } = setupIntegration();

    await expect(
      getRenderModule({ contents: "", fileUrl: entryUrl, viteId: entryPath }),
    ).resolves.toBeUndefined();
  });

  test("does not render twice when Astro also dispatches getRenderModule", async () => {
    const { load, getRenderModule, context } = setupIntegration();

    const module = await load.handler.call(context, entryId);

    await expect(
      getRenderModule({ contents: module.code, fileUrl: entryUrl, viteId: entryId }),
    ).resolves.toBeUndefined();
  });

  test("renders from getRenderModule when the load hook did not run", async () => {
    const { load, getRenderModule, context } = setupIntegration();

    const fromRenderModule = await getRenderModule({
      contents: "export default 'rendered by another plugin'",
      fileUrl: entryUrl,
      viteId: entryId,
    });
    const fromLoad = await load.handler.call(context, entryId);

    expect(fromRenderModule?.code).toBe(fromLoad.code);
  });
});
