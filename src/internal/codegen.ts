import type { MarkdownHeading } from "astro";

import type { Segment } from "./sentinel.js";

interface GenerateContentModuleOptions {
  componentImports: Record<string, string>;
  fileUrl: URL;
  frontmatter: Record<string, unknown>;
  headings: MarkdownHeading[];
  html: string;
  localImagePaths: string[];
  remoteImagePaths: string[];
  segments: Segment[];
}

interface IndexedHtmlSegment {
  type: "html";
  value: string;
  index: number;
}

interface IndexedDirectiveSegment {
  type: "directive";
  directive: Extract<Segment, { type: "directive" }>["directive"];
  children: IndexedSegment[];
}

type IndexedSegment = IndexedHtmlSegment | IndexedDirectiveSegment;

export function generateContentModule(options: GenerateContentModuleOptions): string {
  const htmlValues: string[] = [];
  const segments = indexHtml(options.segments, htmlValues);
  const referencedNames = collectDirectiveNames(segments);
  const componentVariables = new Map<string, string>();
  const variableByImport = new Map<string, string>();
  const componentImportLines: string[] = [];

  for (const name of referencedNames) {
    const specifier = options.componentImports[name];
    if (!specifier) {
      throw new Error(
        `Directive ${JSON.stringify(name)} reached code generation without a registered component.`,
      );
    }
    let variable = variableByImport.get(specifier);
    if (!variable) {
      variable = `__AstroDirectiveComponent${variableByImport.size}`;
      variableByImport.set(specifier, variable);
      componentImportLines.push(`import ${variable} from ${JSON.stringify(specifier)};`);
    }
    componentVariables.set(name, variable);
  }

  const imageImports = options.localImagePaths.map(
    (path, index) => `import __AstroDirectiveImage${index} from ${JSON.stringify(path)};`,
  );
  const hasImages = options.localImagePaths.length > 0 || options.remoteImagePaths.length > 0;
  const renderBody = renderSegments(segments, componentVariables);

  return `${componentImportLines.join("\n")}
${imageImports.join("\n")}
import { createComponent, maybeRenderHead, render, renderComponent, spreadAttributes, unescapeHTML } from "astro/runtime/server/index.js";
${hasImages ? 'import { getImage } from "astro:assets";' : ""}

export const frontmatter = ${JSON.stringify(options.frontmatter)};
export const file = ${JSON.stringify(fileUrlToDisplayPath(options.fileUrl))};
export function getHeadings() { return ${JSON.stringify(options.headings)}; }

const __staticHtml = ${JSON.stringify(htmlValues)};
${hasImages ? imageRuntime(options) : "const __renderedHtml = Promise.resolve(__staticHtml);"}

export const Content = createComponent(async (result) => {
  const __html = await __renderedHtml;
  return render\`${"${maybeRenderHead()}"}${renderBody}\`;
});

export default Content;
`;
}

function indexHtml(segments: Segment[], values: string[]): IndexedSegment[] {
  return segments.map((segment) => {
    if (segment.type === "html") {
      const index = values.push(segment.value) - 1;
      return { ...segment, index };
    }
    return {
      ...segment,
      children: indexHtml(segment.children, values),
    };
  });
}

function collectDirectiveNames(segments: IndexedSegment[]): string[] {
  const names = new Set<string>();
  const visit = (items: IndexedSegment[]) => {
    for (const item of items) {
      if (item.type === "directive") {
        names.add(item.directive.name);
        visit(item.children);
      }
    }
  };
  visit(segments);
  return [...names];
}

function renderSegments(segments: IndexedSegment[], variables: Map<string, string>): string {
  return segments
    .map((segment) => {
      if (segment.type === "html") {
        return `\${unescapeHTML(__html[${segment.index}])}`;
      }

      const variable = variables.get(segment.directive.name);
      if (!variable) throw new Error(`Missing component variable for ${segment.directive.name}.`);
      const children = renderSegments(segment.children, variables);
      const slots = children ? `, { 'default': () => render\`${children}\` }` : "";
      return `\${renderComponent(result, ${JSON.stringify(segment.directive.name)}, ${variable}, ${JSON.stringify(segment.directive.props)}${slots})}`;
    })
    .join("");
}

function imageRuntime(options: GenerateContentModuleOptions): string {
  const localEntries = options.localImagePaths.map(
    (path, index) => `[${JSON.stringify(path)}, __AstroDirectiveImage${index}]`,
  );

  return `const __rawHtml = ${JSON.stringify(options.html)};
const __localImages = new Map([${localEntries.join(",")}]);

function __decodeImageProps(value) {
  return JSON.parse(value.replace(/&(?:#x22|quot);/g, '"').replace(/&(?:#x27|apos);/g, "'"));
}

const __imageSources = (async () => {
  const sources = new Map();
  const pattern = /__ASTRO_IMAGE_="([^"]+)"/gm;
  let match;
  while ((match = pattern.exec(__rawHtml)) !== null) {
    const props = __decodeImageProps(match[1]);
    const { src, index, ...rest } = props;
    const imported = __localImages.get(src);
    const image = imported
      ? await getImage({ src: imported, index, ...rest })
      : await getImage({ src, index, ...rest });
    sources.set(src + '_' + index, image);
  }
  return sources;
})();

async function __updateImageReferences(html) {
  const sources = await __imageSources;
  return html.replaceAll(/__ASTRO_IMAGE_="([^"]+)"/gm, (_full, value) => {
    const props = __decodeImageProps(value);
    const image = sources.get(props.src + '_' + props.index);
    if (!image) throw new Error('Could not resolve optimized Markdown image ' + props.src + '.');
    if (image.srcSet && image.srcSet.values.length > 0) {
      image.attributes.srcset = image.srcSet.attribute;
    }
    const { index: _index, ...attributes } = image.attributes;
    return spreadAttributes({ src: image.src, ...attributes });
  });
}

const __renderedHtml = Promise.all(__staticHtml.map(__updateImageReferences));`;
}

function fileUrlToDisplayPath(url: URL): string {
  return url.protocol === "file:" ? decodeURIComponent(url.pathname) : url.href;
}
