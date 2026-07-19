import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const run = promisify(execFile);
const fixtureRoot = resolve("tests/fixtures/basic");

test("builds deferred Markdown content with Astro components and assets", async () => {
  await run(process.execPath, [resolve("node_modules/astro/bin/astro.mjs"), "build"], {
    cwd: fixtureRoot,
    env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
  });

  const outputRoot = join(fixtureRoot, "dist");
  const files = await readTree(outputRoot);
  const index = files.get("index.html") ?? "";
  const output = [...files.values()].join("\n");

  expect(index).toContain('<p id="heading-count">1</p>');
  expect(index).toContain(
    '<aside id="alpha" class="callout wide" data-type="warning" data-bare="true"',
  );
  expect(index).toContain("<strong>strong Markdown</strong>");
  expect(index).toContain('<mark data-tone="hot">inline</mark>');
  expect(index).toContain('<span data-external="true">another Sätteri plugin</span>');
  expect(index).toContain('<figure data-video="video-1">Video <em>label</em></figure>');
  expect(index).toContain('class="astro-code');
  expect(index).toMatch(/<img[^>]+alt="Pixel"/);
  expect(output).toContain("border:2px solid #f36");
  expect(output).toContain("fixtureLoaded");
  expect(output).not.toContain("astro-directives-sentinel");
  expect(output).not.toContain("__ASTRO_IMAGE_");
  expect(output).not.toContain("This component must never be imported.");
});

async function readTree(root: string, prefix = ""): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) {
      for (const item of await readTree(root, relative)) output.set(...item);
    } else {
      output.set(relative, await readFile(join(root, relative), "utf8"));
    }
  }
  return output;
}
