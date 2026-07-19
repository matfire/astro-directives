import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

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

export interface AstroDirectivesOptions {
  /**
   * Maps directive names to Astro component imports. Relative paths are
   * resolved from the Astro project root.
   */
  components: Record<string, string | URL>;
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
  }): unknown | Promise<unknown>;
  contentModuleTypes?: string;
  handlePropagation?: boolean;
}

/**
 * Render registered Sätteri Markdown directives with Astro components in
 * deferred `.md` content collection entries.
 */
export function astroDirectives(options: AstroDirectivesOptions): AstroIntegration {
  assertOptions(options);

  const componentNames = Object.keys(options.components);
  const directivePlugin = createAstroDirectivesPlugin({
    directives: componentNames,
    throwOnUnknownDirectives: options.throwOnUnknownDirectives,
  });
  let resolvedConfig: AstroConfig | undefined;
  let renderer: MarkdownRenderer | undefined;
  let componentImports: Record<string, string> = {};

  return {
    name: PLUGIN_NAME,
    hooks: {
      "astro:config:setup": (setupParams) => {
        const { config } = setupParams;
        const { addContentEntryType } = setupParams as typeof setupParams & {
          addContentEntryType(type: ContentEntryTypeCompat): void;
        };
        assertSatteri(config.markdown.processor);
        assertDirectivesEnabled(config.markdown.processor.options);

        componentImports = resolveComponentImports(options.components, config.root);
        renderer = undefined;

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
          async getRenderModule({ fileUrl, viteId }) {
            if (!resolvedConfig) {
              throw new Error(
                `${PLUGIN_NAME}: Astro configuration was not resolved before rendering ${viteId}.`,
              );
            }

            // Astro's normal Markdown loader runs before content transforms, so
            // `contents` may already be JavaScript here. Read the source to keep
            // this content entry renderer independent from the page/import path.
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

  for (const [name, component] of Object.entries(options.components)) {
    if (!name || !/^[A-Za-z][\w-]*$/.test(name)) {
      throw new TypeError(`${PLUGIN_NAME}: invalid directive name ${JSON.stringify(name)}.`);
    }
    if (!(typeof component === "string" && component.length > 0) && !(component instanceof URL)) {
      throw new TypeError(
        `${PLUGIN_NAME}: component for directive ${JSON.stringify(name)} must be a non-empty import string or URL.`,
      );
    }
  }
}

function resolveComponentImports(
  components: Record<string, string | URL>,
  root: URL,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(components).map(([name, value]) => [name, resolveComponentImport(value, root)]),
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
