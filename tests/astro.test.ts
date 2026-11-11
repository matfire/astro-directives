import { execFile, spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

const run = promisify(execFile);
const fixtureRoot = resolve("tests/fixtures/basic");
const astroBin = resolve("node_modules/astro/bin/astro.mjs");
// Astro behaves differently under Vitest (`astro dev` serves no routes when
// `VITEST` is set), so the CLI runs with the variables Vitest injects removed.
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name !== "NODE_ENV" && !name.startsWith("VITEST"),
    ),
  ),
  NO_COLOR: "1",
  NO_UPDATE_NOTIFIER: "1",
};

// The fixture post references a remote image at this origin (see its
// `image.remotePatterns`), served here so the tests stay offline.
const IMAGE_PORT = 41739;
const DEV_PORT = 41740;
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let imageServer: Server;

beforeAll(async () => {
  imageServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "image/png", "content-length": PIXEL_PNG.length });
    response.end(PIXEL_PNG);
  });
  await new Promise<void>((done) => imageServer.listen(IMAGE_PORT, done));
});

afterAll(async () => {
  await new Promise((done) => imageServer.close(done));
});

/** Assertions shared by `astro build` and `astro dev` for the collection entry. */
function expectDirectiveMarkup(index: string): void {
  // `astro dev` adds source annotations to component elements, hence `[^>]*`.
  expect(index).toMatch(/<p id="heading-count"[^>]*>1<\/p>/);
  // Container directive: attributes, `#id`, `.class` and bare attributes as props.
  expect(index).toMatch(
    /<aside id="alpha" class="callout wide" data-type="warning" data-bare="true"[^>]*>/,
  );
  // Markdown and a text directive inside the container's default slot.
  expect(index).toContain("<strong>strong Markdown</strong>");
  expect(index).toMatch(/<mark data-tone="hot"[^>]*>inline<\/mark>/);
  // Leaf directive with its label as slot content.
  expect(index).toMatch(/<figure data-video="video-1"[^>]*>Video <em>label<\/em><\/figure>/);
  // Nested containers keep rendering their Markdown children.
  expect(index).toMatch(
    /<aside class="callout" data-type="outer"[^>]*><ul>\s*<li>Outer <strong>list item<\/strong><\/li>\s*<\/ul><aside class="callout" data-type="inner"[^>]*><p>Inner <code>code<\/code><\/p><\/aside><\/aside>/,
  );
  // Directives owned by other Sätteri plugins and regular Markdown features.
  expect(index).toContain('<span data-external="true">another Sätteri plugin</span>');
  expect(index).toContain('class="astro-code');
  // Local and remote images go through `resolveImages` and `astro:assets`.
  expect(index).toMatch(/<img[^>]+src="\/_(?:astro|image)[^"]+"[^>]+alt="Pixel"/);
  expect(index).toMatch(/<img[^>]+src="\/_(?:astro|image)[^"]+"[^>]+alt="Remote"/);
  expect(index).not.toContain("astro-directives-sentinel");
  expect(index).not.toContain("__ASTRO_IMAGE_");
}

/** Markdown outside content collections must stay on Astro's own pipeline. */
function expectAstroMarkdownPipeline(index: string, page: string): void {
  // Direct import: `rawContent()` only exists on Astro's Markdown modules.
  expect(index).toMatch(
    /<section id="direct" data-title="Direct import" data-raw="Imported _directly_ from an Astro page\."[^>]*><p>Imported <em>directly<\/em> from an Astro page\.<\/p>/,
  );
  // Markdown page: the frontmatter `layout` is applied by Astro's pipeline.
  expect(page).toMatch(
    /<main id="page-layout" data-title="Markdown page"[^>]*><h1 id="markdown-page">Markdown page<\/h1>/,
  );
  expect(page).toContain("<strong>Markdown pipeline</strong>");
}

describe("astro build", () => {
  test(
    "renders directives in content entries with Astro components and assets",
    {
      timeout: 60_000,
    },
    async () => {
      await run(process.execPath, [astroBin, "build"], { cwd: fixtureRoot, env });

      const files = await readTree(join(fixtureRoot, "dist"));
      const index = files.get("index.html") ?? "";
      const output = [...files.values()].join("\n");

      expectDirectiveMarkup(index);
      expectAstroMarkdownPipeline(index, files.get(join("page", "index.html")) ?? "");
      expect(index).toMatch(/<img[^>]+src="\/_astro\/remote[^"]+\.webp"[^>]+alt="Remote"/);
      // Component styles and scripts are propagated from the content entry.
      expect(output).toContain("border:2px solid #f36");
      expect(output).toContain("fixtureLoaded");
      expect(output).not.toContain("astro-directives-sentinel");
      expect(output).not.toContain("__ASTRO_IMAGE_");
      expect(output).not.toContain("This component must never be imported.");
    },
  );

  test(
    "fails on unknown directives with the Markdown file and line",
    {
      timeout: 60_000,
    },
    async () => {
      const build = run(process.execPath, [astroBin, "build"], {
        cwd: fixtureRoot,
        env: { ...env, FIXTURE_THROW_ON_UNKNOWN: "true" },
      });

      const error = await build.then(
        () => undefined,
        (error: Error & { stdout: string; stderr: string }) => error,
      );
      const output = `${error?.stdout}\n${error?.stderr}`;

      expect(error).toBeDefined();
      expect(output).toContain('Unknown directive ":external".');
      expect(output).toContain(`${join(fixtureRoot, "src/content/posts/post.md")}:11:12`);
    },
  );
});

describe("astro dev", () => {
  test("renders directives in content entries", { timeout: 60_000 }, async () => {
    // `--ignore-lock` keeps the server in the foreground: without it Astro
    // detaches a background server when it detects an AI agent's shell, and
    // killing the child would leave that server running.
    const server = spawn(
      process.execPath,
      [astroBin, "dev", "--port", String(DEV_PORT), "--ignore-lock"],
      { cwd: fixtureRoot, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let log = "";
    server.stdout.on("data", (chunk) => (log += chunk));
    server.stderr.on("data", (chunk) => (log += chunk));

    try {
      const origin = `http://localhost:${DEV_PORT}`;
      await waitForServer(origin, () => log);

      const index = await (await fetch(`${origin}/`)).text();
      const page = await (await fetch(`${origin}/page/`)).text();

      expectDirectiveMarkup(index);
      expectAstroMarkdownPipeline(index, page);
      // Component styles are collected from the content entry in dev as well.
      expect(index).toMatch(/\.callout\[[^\]]+\]\s*\{\s*border:\s*2px solid/);
    } finally {
      server.kill();
    }
  });
});

async function waitForServer(origin: string, log: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = await fetch(origin).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`astro dev did not start on ${origin}:\n${log()}`);
}

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
