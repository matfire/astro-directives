import { Buffer } from "node:buffer";

import type { Position } from "satteri";

import type { DirectiveKind } from "../types.js";

export const SENTINEL_TAG = "astro-directives-sentinel";
export const SENTINEL_ATTRIBUTE = "data-astro-directive";

export interface SentinelPayload {
  kind: DirectiveKind;
  name: string;
  props: Record<string, string | true>;
  position?: Position;
}

export interface HtmlSegment {
  type: "html";
  value: string;
}

export interface DirectiveSegment {
  type: "directive";
  directive: SentinelPayload;
  children: Segment[];
}

export type Segment = HtmlSegment | DirectiveSegment;

export function encodeSentinelPayload(payload: SentinelPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeSentinelPayload(value: string): SentinelPayload {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch (cause) {
    throw malformedSentinel("could not decode its payload", undefined, cause);
  }

  if (
    !decoded ||
    typeof decoded !== "object" ||
    !("name" in decoded) ||
    typeof decoded.name !== "string" ||
    !("kind" in decoded) ||
    !["container", "leaf", "text"].includes(String(decoded.kind)) ||
    !("props" in decoded) ||
    !decoded.props ||
    typeof decoded.props !== "object"
  ) {
    throw malformedSentinel("has an invalid payload");
  }

  return decoded as SentinelPayload;
}

/** Parse the generated sentinel stream into nested HTML/component segments. */
export function parseSentinelHtml(html: string, fileUrl?: URL): Segment[] {
  const pattern = new RegExp(
    `<${SENTINEL_TAG}\\s+${SENTINEL_ATTRIBUTE}="([A-Za-z0-9_-]+)"\\s*>|<\\/${SENTINEL_TAG}\\s*>`,
    "g",
  );
  const root: Segment[] = [];
  const stack: Array<{ directive: SentinelPayload; children: Segment[] }> = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  const current = () => stack.at(-1)?.children ?? root;
  const appendHtml = (value: string) => {
    if (!value) return;
    const children = current();
    const previous = children.at(-1);
    if (previous?.type === "html") previous.value += value;
    else children.push({ type: "html", value });
  };

  while ((match = pattern.exec(html))) {
    appendHtml(html.slice(cursor, match.index));

    if (match[1]) {
      const directive = decodeSentinelPayload(match[1]);
      stack.push({ directive, children: [] });
    } else {
      const frame = stack.pop();
      if (!frame) {
        throw malformedSentinel("contains an unexpected closing element", fileUrl);
      }
      current().push({
        type: "directive",
        directive: frame.directive,
        children: frame.children,
      });
    }

    cursor = pattern.lastIndex;
  }

  appendHtml(html.slice(cursor));

  if (stack.length > 0) {
    const frame = stack.at(-1)!;
    throw malformedSentinel(
      `does not close the ${JSON.stringify(frame.directive.name)} directive`,
      fileUrl,
      undefined,
      frame.directive.position,
    );
  }

  if (html.includes(`<${SENTINEL_TAG}`) || html.includes(`</${SENTINEL_TAG}`)) {
    // Every valid sentinel was consumed above, so a remaining tag is malformed
    // only if it survived inside a static segment.
    const leftover = root.some((segment) =>
      segment.type === "html"
        ? segment.value.includes(SENTINEL_TAG)
        : containsSentinelText(segment.children),
    );
    if (leftover) {
      throw malformedSentinel("contains an invalid internal element", fileUrl);
    }
  }

  return root;
}

function containsSentinelText(segments: Segment[]): boolean {
  return segments.some((segment) =>
    segment.type === "html"
      ? segment.value.includes(SENTINEL_TAG)
      : containsSentinelText(segment.children),
  );
}

function malformedSentinel(
  reason: string,
  fileUrl?: URL,
  cause?: unknown,
  position?: Position,
): Error {
  const start = position?.start;
  const file = fileUrl
    ? fileUrl.protocol === "file:"
      ? fileURLToPathSafe(fileUrl)
      : fileUrl.href
    : undefined;
  const location = [file, start?.line, start?.column].filter(Boolean).join(":");
  const error = new Error(
    `Malformed internal Astro directive stream: it ${reason}.${location ? `\n  at ${location}` : ""}`,
    { cause },
  ) as Error & {
    loc?: { file?: string; line?: number; column?: number };
  };
  error.name = "AstroDirectivesError";
  error.loc = { file, line: start?.line, column: start?.column };
  return error;
}

function fileURLToPathSafe(url: URL): string {
  return decodeURIComponent(url.pathname);
}
