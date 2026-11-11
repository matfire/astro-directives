import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createSatteriMarkdownProcessor,
  isSatteriProcessor,
  type SatteriResolvedOptions,
} from "@astrojs/markdown-satteri";
import type { AstroConfig, AstroIntegration } from "astro";
import {
  createDefaultAstroMetadata,
  parseFrontmatter,
  type MarkdownRenderer,
} from "astro/markdown";

import { generateContentModule } from "./internal/codegen.js";
import { parseSentinelHtml } from "./internal/sentinel.js";
import { createAstroDirectivesPlugin, PLUGIN_NAME } from "./satteri.js";
import type { DirectiveKind } from "./types.js";

export type { DirectiveKind } from "./types.js";

export interface AstroDirectiveComponent {
  /** Astro component import. Relative paths resolve from the project root. */
  component: string | URL;
  /** The only directive form that may render this component. */
  type: DirectiveKind;
}

export interface AstroDirectivesOptions {
  /**
   * Maps directive names to typed Astro component descriptors.
   */
  components: Record<string, AstroDirectiveComponent>;
  /**
   * Throw when a directive is not registered. Disable this to leave unknown
   * directive nodes untouched. Defaults to `true`.
   */
  throwOnUnknownDirectives?: boolean;
}

const CONTENT_MODULE_TYPES = `declare module 'astro:content' {
  interface Render {
    '.md': Promise<{
      Content: import('astro/runtime/server/index.js').AstroComponentFactory;
      headings: import('astro').MarkdownHeading[];
      remarkPluginFrontmatter: Record<string, any>;
    }>;
  }
}`;

// Astro imports the module that renders a Markdown content collection entry
// as `<file>.md?astroMarkdownContentEntry` (since 7.3.7). Markdown pages and
// direct `.md` imports use the bare path, and the other content flags
// (`astroPropagatedAssets`, `astroRenderContent`, ...) are wrappers that Astro
// generates itself, so this flag is the only id this package takes over.
const MARKDOWN_CONTENT_ENTRY_FLAG = "astroMarkdownContentEntry";
const CONTENT_ENTRY_ID = new RegExp(`\\.md\\?(?:.*&)?${MARKDOWN_CONTENT_ENTRY_FLAG}(?:&|=|$)`);
// Mirrors Vite's special queries: `?raw`, `?url` and `?direct` ask for the
// file itself, never for a rendered module.
const SPECIAL_QUERY = /(?:\?|&)(?:url|raw|direct)(?:&|$)/;
const FIRST_ASTRO_WITH_ENTRY_FLAG = [7, 3, 7] as const;

interface RenderModule {
  code: string;
  map: { mappings: "" };
  meta: {
    astro: ReturnType<typeof createDefaultAstroMetadata>;
    vite: { lang: "ts" };
  };
}

// Astro 7's integration runtime exposes this hook even though the public
// BaseIntegrationHooks type does not yet declare it.
interface ContentEntryTypeCompat {
  extensions: string[];
  getEntryInfo(params: { contents: string; fileUrl: URL }):
    | {
        data: Record<string, unknown>;
        body: string;
        slug?: string;
        rawData: string;
      }
    | Promise<{
        data: Record<string, unknown>;
        body: string;
        slug?: string;
        rawData: string;
      }>;
  getRenderModule(params: {
    contents: string;
    fileUrl: URL;
    viteId: string;
  }): RenderModule | undefined | Promise<RenderModule | undefined>;
  contentModuleTypes?: string;
  handlePropagation?: boolean;
}

/**
 * Render registered Sätteri Markdown directives with Astro components in
 * deferred `.md` content collection entries.
 */
export function astroDirectives(options: AstroDirectivesOptions): AstroIntegration {
  assertOptions(options);

  const directivePlugin = createAstroDirectivesPlugin({
    directives: Object.fromEntries(
      Object.entries(options.components).map(([name, descriptor]) => [name, descriptor.type]),
    ),
    throwOnUnknownDirectives: options.throwOnUnknownDirectives,
  });
  let resolvedConfig: AstroConfig | undefined;
  let renderer: MarkdownRenderer | undefined;
  let componentImports: Record<string, string> = {};
  // Ids whose module was produced by this package's `load` hook.
  const loadedIds = new Set<string>();
  const legacyBareEntryIds = importsContentEntriesByBarePath();

  async function renderContentEntry(fileUrl: URL, viteId: string): Promise<RenderModule> {
    if (!resolvedConfig) {
      throw new Error(
        `${PLUGIN_NAME}: Astro configuration was not resolved before rendering ${viteId}.`,
      );
    }

    const source = await readFile(fileUrl, "utf8");
    const parsed = parseFrontmatter(source, {
      frontmatter: "empty-with-spaces",
    });

    assertSatteri(resolvedConfig.markdown.processor);
    const processorOptions = resolvedConfig.markdown.processor.options;
    renderer ??= await createSatteriMarkdownProcessor({
      image: resolvedConfig.image,
      syntaxHighlight: resolvedConfig.markdown.syntaxHighlight,
      shikiConfig: resolvedConfig.markdown.shikiConfig,
      gfm: resolvedConfig.markdown.gfm,
      smartypants: resolvedConfig.markdown.smartypants,
      mdastPlugins: [...processorOptions.mdastPlugins, directivePlugin],
      hastPlugins: [...processorOptions.hastPlugins],
      features: { ...processorOptions.features },
    });

    const rendered = await renderer.render(parsed.content, {
      fileURL: fileUrl,
      frontmatter: parsed.frontmatter,
    });
    const segments = parseSentinelHtml(rendered.code, fileUrl);
    const code = generateContentModule({
      componentImports,
      fileUrl,
      frontmatter: rendered.metadata.frontmatter,
      headings: rendered.metadata.headings,
      html: rendered.code,
      localImagePaths: rendered.metadata.localImagePaths,
      remoteImagePaths: rendered.metadata.remoteImagePaths,
      segments,
    });

    return {
      code,
      map: { mappings: "" },
      meta: {
        astro: createDefaultAstroMetadata(),
        vite: { lang: "ts" },
      },
    };
  }

  return {
    name: PLUGIN_NAME,
    hooks: {
      "astro:config:setup": (setupParams) => {
        const { config, updateConfig } = setupParams;
        const { addContentEntryType } = setupParams as typeof setupParams & {
          addContentEntryType(type: ContentEntryTypeCompat): void;
        };
        assertSatteri(config.markdown.processor);
        assertDirectivesEnabled(config.markdown.processor.options);

        componentImports = resolveComponentImports(options.components, config.root);
        renderer = undefined;
        loadedIds.clear();

        updateConfig({
          vite: {
            plugins: [
              {
                name: `${PLUGIN_NAME}:content-entry`,
                // Astro only dispatches `getRenderModule` from a transform
                // whose filter requires the id to END in the extension, so it
                // never fires for `.md?astroMarkdownContentEntry` and the
                // built-in `astro:markdown` plugin renders the entry without
                // the directive plugin. Produce the module here instead.
                //
                // `load` rather than `transform`: a transform would run after
                // `astro:markdown` has already rendered the file once (and
                // thrown away every directive), would depend on that render
                // succeeding, and would only replace its output. Claiming the
                // id in `load` renders each entry exactly once. `astro:markdown`
                // is `enforce: "pre"` too and is registered before integration
                // plugins, so plugin-level ordering alone would lose the race;
                // the hook-level `order: "pre"` sorts this `load` ahead of
                // every `load` hook that does not ask for the same.
                enforce: "pre",
                load: {
                  order: "pre",
                  filter: { id: { include: CONTENT_ENTRY_ID, exclude: SPECIAL_QUERY } },
                  async handler(this: { addWatchFile(file: string): void }, id: string) {
                    if (!isMarkdownContentEntryId(id)) return;
                    const fileId = id.slice(0, id.indexOf("?"));
                    // The source is read from disk rather than handed over by
                    // Vite, so register it for rebuilds explicitly.
                    this.addWatchFile(fileId);
                    const module = await renderContentEntry(pathToFileURL(fileId), id);
                    loadedIds.add(id);
                    return module;
                  },
                },
              },
            ],
          },
        });

        addContentEntryType({
          extensions: [".md"],
          async getEntryInfo({ contents }) {
            const parsed = parseFrontmatter(contents, {
              frontmatter: "empty-with-spaces",
            });

            return {
              data: parsed.frontmatter,
              body: parsed.content.trim(),
              slug: parsed.frontmatter.slug,
              rawData: parsed.rawFrontmatter,
            };
          },
          contentModuleTypes: CONTENT_MODULE_TYPES,
          handlePropagation: true,
          // Kept so the entry type stays complete: should Astro dispatch this
          // hook for query-suffixed ids again, both paths must agree.
          async getRenderModule({ fileUrl, viteId }) {
            if (!isMarkdownContentEntryId(viteId)) {
              // A bare `.md` id is a Markdown page or a direct import, which
              // belong to Astro's own pipeline. Older Astro versions use it
              // for content entries as well and cannot tell them apart.
              if (!legacyBareEntryIds) return undefined;
            } else if (loadedIds.has(viteId)) {
              // The `load` hook above already produced this module; leaving
              // the transform a no-op keeps the two paths from rendering twice.
              return undefined;
            }
            // `contents` is whatever was loaded for the id, usually Astro's
            // own Markdown module, so render from the source on disk.
            return renderContentEntry(fileUrl, viteId);
          },
        });
      },
      "astro:config:done": ({ config }) => {
        assertSatteri(config.markdown.processor);
        assertDirectivesEnabled(config.markdown.processor.options);
        resolvedConfig = config;
      },
    },
  };
}

function isMarkdownContentEntryId(id: string): boolean {
  return CONTENT_ENTRY_ID.test(id) && !SPECIAL_QUERY.test(id);
}

/**
 * Astro before 7.3.7 imports content entries by their bare path, the same id
 * as Markdown pages and direct imports, and does dispatch `getRenderModule`
 * for it.
 */
function importsContentEntriesByBarePath(): boolean {
  let version: string;
  try {
    ({ version } = createRequire(import.meta.url)("astro/package.json") as { version: string });
  } catch {
    return false;
  }

  const parts = version.split(/[.-]/, 3).map(Number);
  for (const [index, firstFlagged] of FIRST_ASTRO_WITH_ENTRY_FLAG.entries()) {
    const part = parts[index] ?? 0;
    if (part !== firstFlagged) return part < firstFlagged;
  }
  return false;
}

function assertDirectivesEnabled(options: SatteriResolvedOptions): void {
  if (options.features.directive !== true) {
    throw new Error(
      `${PLUGIN_NAME} requires Sätteri directives to be enabled. Configure markdown.processor with satteri({ features: { directive: true } }) from "@astrojs/markdown-satteri".`,
    );
  }
}

function assertSatteri(
  processor: AstroConfig["markdown"]["processor"],
): asserts processor is AstroConfig["markdown"]["processor"] & {
  options: SatteriResolvedOptions;
} {
  if (!isSatteriProcessor(processor)) {
    throw new Error(
      `${PLUGIN_NAME} requires Astro's Sätteri Markdown processor. Remove the custom markdown.processor, or configure satteri() from "@astrojs/markdown-satteri" before astroDirectives().`,
    );
  }
}

function assertOptions(options: AstroDirectivesOptions): void {
  if (!options || typeof options !== "object" || !options.components) {
    throw new TypeError(`${PLUGIN_NAME}: a components registry is required.`);
  }

  for (const [name, descriptor] of Object.entries(options.components)) {
    if (!name || !/^[A-Za-z][\w-]*$/.test(name)) {
      throw new TypeError(`${PLUGIN_NAME}: invalid directive name ${JSON.stringify(name)}.`);
    }
    if (!descriptor || typeof descriptor !== "object" || descriptor instanceof URL) {
      throw new TypeError(
        `${PLUGIN_NAME}: component for directive ${JSON.stringify(name)} must be an object with component and type properties.`,
      );
    }
    const { component, type } = descriptor;
    if (!(typeof component === "string" && component.length > 0) && !(component instanceof URL)) {
      throw new TypeError(
        `${PLUGIN_NAME}: component for directive ${JSON.stringify(name)} must be a non-empty import string or URL.`,
      );
    }
    if (type !== "container" && type !== "leaf" && type !== "text") {
      throw new TypeError(
        `${PLUGIN_NAME}: directive ${JSON.stringify(name)} must have type "container", "leaf", or "text".`,
      );
    }
  }
}

function resolveComponentImports(
  components: Record<string, AstroDirectiveComponent>,
  root: URL,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(components).map(([name, descriptor]) => [
      name,
      resolveComponentImport(descriptor.component, root),
    ]),
  );
}

function resolveComponentImport(value: string | URL, root: URL): string {
  if (value instanceof URL) {
    return value.protocol === "file:" ? fileURLToPath(value) : value.href;
  }

  if (value.startsWith(".")) {
    return fileURLToPath(new URL(value, root));
  }

  if (isAbsolute(value)) return value;

  if (URL.canParse(value) && value.includes(":")) {
    const url = new URL(value);
    return url.protocol === "file:" ? fileURLToPath(url) : url.href;
  }

  return value;
}

export default astroDirectives;
