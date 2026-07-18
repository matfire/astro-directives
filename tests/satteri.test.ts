import { markdownToHtml } from "satteri";
import { describe, expect, test } from "vitest";

import { createAstroDirectivesPlugin } from "../src/satteri.js";
import {
  parseSentinelHtml,
  type DirectiveSegment,
  type Segment,
} from "../src/internal/sentinel.js";

const directives = createAstroDirectivesPlugin({
  directives: ["callout", "youtube", "badge"],
});

async function compile(markdown: string): Promise<Segment[]> {
  const result = await markdownToHtml(markdown, {
    features: { directive: true },
    mdastPlugins: [directives],
    fileURL: new URL("file:///project/src/content/post.md"),
  });
  return parseSentinelHtml(result.html);
}

function components(segments: Segment[]): DirectiveSegment[] {
  return segments.flatMap((segment) =>
    segment.type === "directive" ? [segment, ...components(segment.children)] : [],
  );
}

describe("Sätteri directive plugin", () => {
  test("supports container, leaf, and inline forms with Markdown slots", async () => {
    const result = await compile(`::::callout{type="warning" #notice .wide disabled}
Container with **strong text**.

:::callout
Nested content.
:::
::::

::youtube[Watch *now*]{id="abc"}

Before :badge[hot]{tone="positive"} after.`);

    const found = components(result);
    expect(found.map((item) => item.directive.kind)).toEqual([
      "container",
      "container",
      "leaf",
      "text",
    ]);
    expect(found[0]?.directive.props).toEqual({
      type: "warning",
      id: "notice",
      class: "wide",
      disabled: true,
    });
    expect(found[0]?.children).toContainEqual(
      expect.objectContaining({
        type: "html",
        value: expect.stringContaining("<strong>strong text</strong>"),
      }),
    );
    expect(found[2]?.children).toContainEqual(
      expect.objectContaining({
        type: "html",
        value: expect.stringContaining("<em>now</em>"),
      }),
    );
  });

  test("preserves unicode and escaped attribute values", async () => {
    const found = components(await compile(':badge[café]{label="A & B — café" empty=""}'));
    expect(found[0]?.directive.props).toEqual({
      label: "A & B — café",
      empty: "",
    });
    expect(found[0]?.children).toEqual([expect.objectContaining({ type: "html", value: "café" })]);
  });

  test("keeps adjacent inline directives as separate components", async () => {
    const found = components(await compile(":badge[one]:badge[two]"));
    expect(found.map((item) => item.directive.name)).toEqual(["badge", "badge"]);
    expect(found.map((item) => item.children[0])).toEqual([
      expect.objectContaining({ value: "one" }),
      expect.objectContaining({ value: "two" }),
    ]);
  });

  test("fails unregistered names with the Markdown location", async () => {
    let thrown: (Error & { loc?: { line?: number; column?: number } }) | undefined;
    try {
      await compile('\n\n::missing{id="x"}');
    } catch (error) {
      thrown = error as typeof thrown;
    }

    expect(thrown?.message).toContain('Unknown directive "::missing"');
    expect(thrown?.message).toContain("/project/src/content/post.md:3:1");
    expect(thrown?.loc).toEqual(expect.objectContaining({ line: 3, column: 1 }));
  });
});
