import { defineMdastPlugin, markdownToHtml, type MdastPluginDefinition } from "satteri";
import { describe, expect, test } from "vitest";

import { createAstroDirectivesPlugin } from "../src/satteri.js";
import {
  parseSentinelHtml,
  type DirectiveSegment,
  type Segment,
} from "../src/internal/sentinel.js";

const directives = createAstroDirectivesPlugin({
  directives: { callout: "container", youtube: "leaf", badge: "text" },
});

async function compile(
  markdown: string,
  mdastPlugins: MdastPluginDefinition[] = [directives],
): Promise<Segment[]> {
  const result = await markdownToHtml(markdown, {
    features: { directive: true },
    mdastPlugins,
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

  test("distinguishes bare attributes from assignments in quoted values", async () => {
    const found = components(
      await compile(':badge[text]{title=" disabled=" escaped="say \\" disabled=" disabled}'),
    );

    expect(found[0]?.directive.props).toEqual({
      title: " disabled=",
      escaped: 'say \\" disabled=',
      disabled: true,
    });
  });

  test("ignores assignments in directive labels and container bodies", async () => {
    const found = components(
      await compile(`:badge[label disabled=]{disabled}

:::callout{disabled}
Body containing disabled= text.
:::`),
    );

    expect(found.map((item) => item.directive.props.disabled)).toEqual([true, true]);
  });

  test("preserves explicitly assigned empty attributes with optional spacing", async () => {
    const found = components(await compile(':badge[text]{first="" second = "" bare}'));

    expect(found[0]?.directive.props).toEqual({ first: "", second: "", bare: true });
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
    expect(thrown?.message).toContain(
      'components: { "missing": { component: "...", type: "leaf" } }',
    );
    expect(thrown?.message).toContain("/project/src/content/post.md:3:1");
    expect(thrown?.loc).toEqual(expect.objectContaining({ line: 3, column: 1 }));
  });

  test("fails unregistered names when explicitly enabled", async () => {
    const explicitStrictDirectives = createAstroDirectivesPlugin({
      directives: { badge: "text" },
      throwOnUnknownDirectives: true,
    });

    await expect(compile(":missing[text]", [explicitStrictDirectives])).rejects.toThrowError(
      'Unknown directive ":missing"',
    );
  });

  test("ignores every unregistered directive form when configured", async () => {
    const lenientDirectives = createAstroDirectivesPlugin({
      directives: { badge: "text" },
      throwOnUnknownDirectives: false,
    });
    const result = await compile(
      `:::external
container
:::

::external

:external[text]

:badge[registered]`,
      [lenientDirectives],
    );

    expect(components(result).map((item) => item.directive.name)).toEqual(["badge"]);
  });

  test("allows other plugins to handle unregistered directives when configured", async () => {
    const externalPlugin = defineMdastPlugin({
      name: "external-directive",
      textDirective(node, context) {
        if (node.name !== "external") return;
        context.setProperty(node, "data", {
          ...node.data,
          hName: "span",
          hProperties: { "data-external": "true" },
        });
      },
    });
    const lenientDirectives = createAstroDirectivesPlugin({
      directives: { badge: "text" },
      throwOnUnknownDirectives: false,
    });

    const result = await compile(":external[other plugin] and :badge[registered] and ::unhandled", [
      externalPlugin,
      lenientDirectives,
    ]);

    expect(result).toContainEqual(
      expect.objectContaining({
        type: "html",
        value: expect.stringContaining('<span data-external="true">other plugin</span>'),
      }),
    );
    expect(components(result).map((item) => item.directive.name)).toEqual(["badge"]);
  });

  test("rejects a non-boolean unknown-directive option", () => {
    expect(() =>
      createAstroDirectivesPlugin({
        directives: {},
        throwOnUnknownDirectives: "no" as unknown as boolean,
      }),
    ).toThrowError(/throwOnUnknownDirectives must be a boolean/);
  });

  test.each([
    {
      markdown: ":::badge\ncontent\n:::",
      expected: "text",
      detected: "container",
      syntax: ":::badge",
    },
    { markdown: "::badge[label]", expected: "container", detected: "leaf", syntax: "::badge" },
    { markdown: ":badge[label]", expected: "leaf", detected: "text", syntax: ":badge" },
  ])(
    "fails when $syntax is used as $detected but registered as $expected",
    async ({ markdown, expected, detected, syntax }) => {
      const typedDirectives = createAstroDirectivesPlugin({
        directives: { badge: expected as "container" | "leaf" | "text" },
      });

      let thrown: (Error & { loc?: { file?: string; line?: number; column?: number } }) | undefined;
      try {
        await compile(markdown, [typedDirectives]);
      } catch (error) {
        thrown = error as typeof thrown;
      }

      expect(thrown?.name).toBe("AstroDirectivesError");
      expect(thrown?.message).toContain(`Directive ${JSON.stringify(syntax)}`);
      expect(thrown?.message).toContain(`has type ${JSON.stringify(detected)}`);
      expect(thrown?.message).toContain(`expects type ${JSON.stringify(expected)}`);
      expect(thrown?.message).toContain("/project/src/content/post.md:1:1");
      expect(thrown?.loc).toEqual({
        file: "/project/src/content/post.md",
        line: 1,
        column: 1,
      });
    },
  );

  test("always fails registered type mismatches when unknown directives are allowed", async () => {
    const lenientDirectives = createAstroDirectivesPlugin({
      directives: { badge: "container" },
      throwOnUnknownDirectives: false,
    });

    await expect(compile(":badge[text]", [lenientDirectives])).rejects.toThrowError(
      /expects type "container"/,
    );
  });

  test("requires a name-to-kind directive registry", () => {
    expect(() =>
      createAstroDirectivesPlugin({
        directives: ["badge"] as unknown as Record<string, "text">,
      }),
    ).toThrowError(/directives must be a directive name-to-kind object/);
  });

  test("rejects invalid directive kinds", () => {
    expect(() =>
      createAstroDirectivesPlugin({
        directives: { badge: "inline" as "text" },
      }),
    ).toThrowError(/must have type "container", "leaf", or "text"/);
  });
});
