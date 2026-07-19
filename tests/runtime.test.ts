import { describe, expect, test, vi } from "vitest";

import { resolveImages, type GetImage, type ResolvedImage } from "../src/runtime.js";

function placeholder(props: Record<string, unknown>): string {
  const json = JSON.stringify(props).replaceAll('"', "&#x22;");
  return `__ASTRO_IMAGE_="${json}"`;
}

function optimized(overrides: Partial<ResolvedImage> = {}): ResolvedImage {
  return {
    src: "/_astro/pixel.hash.svg",
    attributes: { alt: "Pixel", index: 0 },
    srcSet: { attribute: "", values: [] },
    ...overrides,
  };
}

describe("image runtime", () => {
  test("resolves local images through their imported asset", async () => {
    const imported = { src: "imported-meta" };
    const getImage = vi.fn<GetImage>(async () => optimized());
    const html = `<p><img ${placeholder({ alt: "Pixel", src: "./pixel.svg", index: 0 })}></p>`;

    const segments = await resolveImages({
      segments: [html],
      html,
      localImages: new Map([["./pixel.svg", imported]]),
      getImage,
    });

    expect(getImage).toHaveBeenCalledExactlyOnceWith({ src: imported, index: 0, alt: "Pixel" });
    expect(segments[0]).toContain('src="/_astro/pixel.hash.svg"');
    expect(segments[0]).toContain('alt="Pixel"');
    expect(segments[0]).not.toContain("__ASTRO_IMAGE_");
    expect(segments[0]).not.toContain("index=");
  });

  test("passes remote sources through untouched", async () => {
    const getImage = vi.fn<GetImage>(async () =>
      optimized({ src: "https://example.com/pic.png", attributes: { index: 0, inferSize: true } }),
    );
    const html = `<img ${placeholder({ src: "https://example.com/pic.png", index: 0, inferSize: true })}>`;

    await resolveImages({ segments: [html], html, localImages: new Map(), getImage });

    expect(getImage).toHaveBeenCalledExactlyOnceWith({
      src: "https://example.com/pic.png",
      index: 0,
      inferSize: true,
    });
  });

  test("adds srcset only when the source set has values", async () => {
    const getImage = vi.fn<GetImage>(async ({ src }) =>
      src === "./with.png"
        ? optimized({ srcSet: { attribute: "/_astro/a.png 1x", values: ["1x"] } })
        : optimized(),
    );
    const html = `<img ${placeholder({ src: "./with.png", index: 0 })}><img ${placeholder({ src: "./without.png", index: 0 })}>`;

    const segments = await resolveImages({
      segments: [html],
      html,
      localImages: new Map(),
      getImage,
    });

    const [withSet, withoutSet] = segments[0]!.split("><img ");
    expect(withSet).toContain('srcset="/_astro/a.png 1x"');
    expect(withoutSet).not.toContain("srcset");
  });

  test("decodes HTML-entity-encoded placeholder props", async () => {
    const getImage = vi.fn<GetImage>(async () => optimized());
    const html = `<img __ASTRO_IMAGE_="{&quot;src&quot;:&quot;./a &#x27;b&#x27;.png&quot;,&quot;index&quot;:0}">`;

    await resolveImages({ segments: [html], html, localImages: new Map(), getImage });

    expect(getImage).toHaveBeenCalledExactlyOnceWith({ src: "./a 'b'.png", index: 0 });
  });

  test("distinguishes repeated sources by index", async () => {
    const getImage = vi.fn<GetImage>(async ({ index }) =>
      optimized({ src: `/_astro/pixel.${String(index)}.svg` }),
    );
    const html = `<img ${placeholder({ src: "./pixel.svg", index: 0 })}><img ${placeholder({ src: "./pixel.svg", index: 1 })}>`;

    const segments = await resolveImages({
      segments: [html],
      html,
      localImages: new Map(),
      getImage,
    });

    expect(getImage).toHaveBeenCalledTimes(2);
    expect(segments[0]).toContain('src="/_astro/pixel.0.svg"');
    expect(segments[0]).toContain('src="/_astro/pixel.1.svg"');
  });

  test("throws for a segment image missing from the scanned HTML", async () => {
    const getImage = vi.fn<GetImage>(async () => optimized());
    const segment = `<img ${placeholder({ src: "./orphan.png", index: 0 })}>`;

    await expect(
      resolveImages({ segments: [segment], html: "", localImages: new Map(), getImage }),
    ).rejects.toThrowError("Could not resolve optimized Markdown image ./orphan.png.");
  });
});
