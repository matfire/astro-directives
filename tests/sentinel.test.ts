import { describe, expect, test } from "vitest";

import { generateContentModule } from "../src/internal/codegen.js";
import {
  encodeSentinelPayload,
  parseSentinelHtml,
  SENTINEL_ATTRIBUTE,
  SENTINEL_TAG,
  type Segment,
} from "../src/internal/sentinel.js";

function open(name: string): string {
  const payload = encodeSentinelPayload({
    kind: "container",
    name,
    props: {},
    position: {
      start: { line: 4, column: 2, offset: 10 },
      end: { line: 6, column: 4, offset: 30 },
    },
  });
  return `<${SENTINEL_TAG} ${SENTINEL_ATTRIBUTE}="${payload}">`;
}

describe("sentinel parser", () => {
  test("parses nested directives without leaking marker HTML", () => {
    const html = `<p>before</p>${open("outer")}<p>slot</p>${open("inner")}inside</${SENTINEL_TAG}></${SENTINEL_TAG}><p>after</p>`;
    const segments = parseSentinelHtml(html);

    expect(segments).toHaveLength(3);
    expect(JSON.stringify(segments)).not.toContain(SENTINEL_TAG);
    expect((segments[1] as Extract<Segment, { type: "directive" }>).children[1]).toMatchObject({
      type: "directive",
      directive: { name: "inner" },
    });
  });

  test("reports source-located malformed nesting", () => {
    expect(() =>
      parseSentinelHtml(open("callout"), new URL("file:///project/post.md")),
    ).toThrowError(/callout[\s\S]*\/project\/post\.md:4:2/);

    expect(() =>
      parseSentinelHtml(`</${SENTINEL_TAG}>`, new URL("file:///project/post.md")),
    ).toThrowError(/unexpected closing element/);
  });
});

describe("content module code generation", () => {
  test("imports only referenced components and deduplicates shared imports", () => {
    const segments: Segment[] = [
      {
        type: "directive",
        directive: { kind: "container", name: "callout", props: {} },
        children: [
          { type: "html", value: "<p>one</p>" },
          {
            type: "directive",
            directive: { kind: "leaf", name: "notice", props: { bare: true } },
            children: [],
          },
        ],
      },
      {
        type: "directive",
        directive: { kind: "container", name: "callout", props: {} },
        children: [],
      },
    ];
    const code = generateContentModule({
      componentImports: {
        callout: "/components/Shared.astro",
        notice: "/components/Shared.astro",
        unused: "/components/Unused.astro",
      },
      fileUrl: new URL("file:///project/post.md"),
      frontmatter: { title: "Post" },
      headings: [],
      html: "",
      localImagePaths: [],
      remoteImagePaths: [],
      segments,
    });

    expect(code.match(/import __AstroDirectiveComponent/g)).toHaveLength(1);
    expect(code).not.toContain("Unused.astro");
    expect(code.match(/renderComponent\(result, "callout"/g)).toHaveLength(2);
    expect(code).toContain('renderComponent(result, "notice"');
    expect(code).toContain('"bare":true');
  });
});
