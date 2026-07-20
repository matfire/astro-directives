import { fileURLToPath } from "node:url";

import {
  defineMdastPlugin,
  type MdastPluginDefinition,
  type MdastNode,
  type MdastVisitorContext,
} from "satteri";

import { encodeSentinelPayload, SENTINEL_ATTRIBUTE, SENTINEL_TAG } from "./internal/sentinel.js";
import type { DirectiveKind } from "./types.js";

export type { DirectiveKind } from "./types.js";

export const PLUGIN_NAME = "@matfire/astro-directives";

export interface SatteriDirectivesOptions {
  /** Maps directive names to their required directive kind. */
  directives: Record<string, DirectiveKind>;
  /**
   * Throw when a directive is not registered. Disable this to leave unknown
   * directive nodes untouched. Defaults to `true`.
   */
  throwOnUnknownDirectives?: boolean;
}

type ContainerDirective = Extract<MdastNode, { type: "containerDirective" }>;
type LeafDirective = Extract<MdastNode, { type: "leafDirective" }>;
type TextDirective = Extract<MdastNode, { type: "textDirective" }>;
type DirectiveAttributes = NonNullable<ContainerDirective["attributes"]>;

/**
 * Replace registered directive nodes with encoded internal elements while
 * leaving their children in Sätteri's normal Markdown pipeline.
 */
export function createAstroDirectivesPlugin(
  options: SatteriDirectivesOptions,
): MdastPluginDefinition {
  if (
    !options?.directives ||
    typeof options.directives !== "object" ||
    Symbol.iterator in options.directives
  ) {
    throw new TypeError(`${PLUGIN_NAME}: directives must be a directive name-to-kind object.`);
  }

  if (
    options.throwOnUnknownDirectives !== undefined &&
    typeof options.throwOnUnknownDirectives !== "boolean"
  ) {
    throw new TypeError(`${PLUGIN_NAME}: throwOnUnknownDirectives must be a boolean.`);
  }

  for (const [name, kind] of Object.entries(options.directives)) {
    if (!isDirectiveKind(kind)) {
      throw new TypeError(
        `${PLUGIN_NAME}: directive ${JSON.stringify(name)} must have type "container", "leaf", or "text".`,
      );
    }
  }

  const directives = new Map(Object.entries(options.directives));
  const throwOnUnknownDirectives = options.throwOnUnknownDirectives ?? true;

  const transform = (
    node: Readonly<ContainerDirective | LeafDirective | TextDirective>,
    context: MdastVisitorContext,
    kind: DirectiveKind,
  ) => {
    const expectedKind = directives.get(node.name);
    if (expectedKind === undefined) {
      if (throwOnUnknownDirectives) throw directiveError(node, context);
      return;
    }
    if (expectedKind !== kind) {
      throw directiveKindError(node, context, kind, expectedKind);
    }

    context.setProperty(node, "data", {
      ...node.data,
      hName: SENTINEL_TAG,
      hProperties: {
        [SENTINEL_ATTRIBUTE]: encodeSentinelPayload({
          kind,
          name: node.name,
          props: normalizeAttributes(node.attributes, node, context),
          position: node.position,
        }),
      },
    });
  };

  return defineMdastPlugin({
    name: PLUGIN_NAME,
    containerDirective(node, context) {
      return transform(node, context, "container");
    },
    leafDirective(node, context) {
      return transform(node, context, "leaf");
    },
    textDirective(node, context) {
      return transform(node, context, "text");
    },
  });
}

function isDirectiveKind(value: unknown): value is DirectiveKind {
  return value === "container" || value === "leaf" || value === "text";
}

function normalizeAttributes(
  attributes: DirectiveAttributes | null | undefined,
  node: Readonly<ContainerDirective | LeafDirective | TextDirective>,
  context: MdastVisitorContext,
): Record<string, string | true> {
  if (!attributes) return {};

  return Object.fromEntries(
    Object.entries(attributes)
      .filter((entry): entry is [string, string | null] => entry[1] !== undefined)
      .map(([name, value]) => [
        name,
        value === null || (value === "" && !hasExplicitAssignment(name, node, context))
          ? true
          : value,
      ]),
  );
}

function hasExplicitAssignment(
  name: string,
  node: Readonly<ContainerDirective | LeafDirective | TextDirective>,
  context: MdastVisitorContext,
): boolean {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return false;

  let source = context.source.slice(start, end);
  if (node.type === "containerDirective") {
    source = source.split(/\r?\n/, 1)[0] ?? source;
  }

  let bracketDepth = 0;
  let inAttributes = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;

    if (inAttributes) {
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = undefined;
        continue;
      }

      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "}") {
        inAttributes = false;
        continue;
      }

      const previous = source[index - 1];
      if ((previous === "{" || /\s/.test(previous ?? "")) && source.startsWith(name, index)) {
        let assignmentIndex = index + name.length;
        while (/\s/.test(source[assignmentIndex] ?? "")) assignmentIndex++;
        if (source[assignmentIndex] === "=") return true;
      }
      continue;
    }

    if (bracketDepth > 0 && character === "\\") {
      index++;
      continue;
    }
    if (character === "[") {
      bracketDepth++;
      continue;
    }
    if (character === "]" && bracketDepth > 0) {
      bracketDepth--;
      continue;
    }
    if (character === "{" && bracketDepth === 0) inAttributes = true;
  }

  return false;
}

function directiveError(
  node: Readonly<ContainerDirective | LeafDirective | TextDirective>,
  context: MdastVisitorContext,
): Error {
  const kind = directiveKind(node);
  return createDirectiveError(
    node,
    context,
    `Unknown directive ${JSON.stringify(directiveLabel(node))}. Register ${JSON.stringify(node.name)} in astroDirectives({ components: { ${JSON.stringify(node.name)}: { component: "...", type: ${JSON.stringify(kind)} } } })`,
  );
}

function directiveKindError(
  node: Readonly<ContainerDirective | LeafDirective | TextDirective>,
  context: MdastVisitorContext,
  detectedKind: DirectiveKind,
  expectedKind: DirectiveKind,
): Error {
  return createDirectiveError(
    node,
    context,
    `Directive ${JSON.stringify(directiveLabel(node))} has type ${JSON.stringify(detectedKind)}, but registered component ${JSON.stringify(node.name)} expects type ${JSON.stringify(expectedKind)}`,
  );
}

function directiveLabel(
  node: Readonly<ContainerDirective | LeafDirective | TextDirective>,
): string {
  const kind = directiveKind(node);
  const prefix = kind === "container" ? ":::" : kind === "leaf" ? "::" : ":";
  return `${prefix}${node.name}`;
}

function directiveKind(
  node: Readonly<ContainerDirective | LeafDirective | TextDirective>,
): DirectiveKind {
  return node.type === "containerDirective"
    ? "container"
    : node.type === "leafDirective"
      ? "leaf"
      : "text";
}

function createDirectiveError(
  node: Readonly<ContainerDirective | LeafDirective | TextDirective>,
  context: MdastVisitorContext,
  message: string,
): Error {
  const start = node.position?.start;
  const file = context.fileURL
    ? context.fileURL.protocol === "file:"
      ? fileURLToPath(context.fileURL)
      : context.fileURL.href
    : undefined;
  const location = [file, start?.line, start?.column].filter(Boolean).join(":");
  const error = new Error(`${message}.${location ? `\n  at ${location}` : ""}`) as Error & {
    loc?: { file?: string; line?: number; column?: number };
  };
  error.name = "AstroDirectivesError";
  error.loc = { file, line: start?.line, column: start?.column };
  return error;
}

export default createAstroDirectivesPlugin;
