import { spreadAttributes } from "astro/runtime/server/index.js";

const IMAGE_PATTERN = /__ASTRO_IMAGE_="([^"]+)"/gm;

/** The subset of Astro's `GetImageResult` the runtime relies on. */
export interface ResolvedImage {
  src: string;
  attributes: Record<string, unknown>;
  srcSet?: { attribute: string; values: unknown[] };
}

export type GetImage = (options: Record<string, unknown>) => Promise<ResolvedImage>;

export interface ResolveImagesOptions {
  /** Static HTML segments whose image placeholders should be rewritten. */
  segments: string[];
  /** Full rendered HTML, scanned once for every image placeholder. */
  html: string;
  /** Markdown image src to imported image asset. */
  localImages: Map<string, unknown>;
  /** Astro's `getImage`, injected by the generated content module. */
  getImage: GetImage;
}

interface ImageProps {
  src: string;
  index: number;
  [key: string]: unknown;
}

/**
 * Resolve `__ASTRO_IMAGE_` placeholders emitted by Sätteri's image marker
 * plugin into optimized image attributes.
 */
export async function resolveImages(options: ResolveImagesOptions): Promise<string[]> {
  const sources = new Map<string, ResolvedImage>();

  await Promise.all(
    Array.from(options.html.matchAll(IMAGE_PATTERN), async (match) => {
      const props = decodeImageProps(match[1]!);
      const { src, index, ...rest } = props;
      const imported = options.localImages.get(src);
      const image = imported
        ? await options.getImage({ src: imported, index, ...rest })
        : await options.getImage({ src, index, ...rest });
      sources.set(src + "_" + index, image);
    }),
  );

  return options.segments.map((segment) =>
    segment.replaceAll(IMAGE_PATTERN, (_full, value: string) => {
      const props = decodeImageProps(value);
      const image = sources.get(props.src + "_" + props.index);
      if (!image) {
        throw new Error("Could not resolve optimized Markdown image " + props.src + ".");
      }
      const resolvedAttributes = { ...image.attributes };
      if (image.srcSet && image.srcSet.values.length > 0) {
        resolvedAttributes.srcset = image.srcSet.attribute;
      }
      const { index: _index, ...attributes } = resolvedAttributes;
      return String(spreadAttributes({ src: image.src, ...attributes }));
    }),
  );
}

function decodeImageProps(value: string): ImageProps {
  return JSON.parse(
    value.replace(/&(?:#x22|quot);/g, '"').replace(/&(?:#x27|apos);/g, "'"),
  ) as ImageProps;
}
