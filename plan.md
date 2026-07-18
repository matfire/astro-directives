# Build `@matfire/astro-directives`

## Summary

Create a publishable workspace package that lets Astro content collections use ordinary `.md` files with Sätteri directives backed by Astro components. It will support container, leaf, and inline directives, preserve Markdown children as the component’s default slot, and fail builds for unregistered names.

## Implementation

- Add `packages/astro-directives` with two exports:
  - `@matfire/astro-directives`: Astro integration.
  - `@matfire/astro-directives/satteri`: reusable Sätteri directive plugin.
- Expose this configuration API:

  ```ts
  astroDirectives({
    components: {
      callout: "./src/components/mdx/Callout.astro",
      youtube: "./src/components/mdx/Youtube.astro",
      stackblitz: "./src/components/mdx/Stackblitz.astro",
      codesandbox: "./src/components/mdx/CodeSandbox.astro",
    },
  });
  ```

  Relative paths resolve from the Astro project root; absolute paths, URLs, and package specifiers remain supported.

- Require Astro 7 and the Sätteri Markdown processor. The integration enables `features.directive`, preserves existing Sätteri plugins, and reports an actionable configuration error for another processor.
- Override `.md` content entries with deferred rendering while leaving Markdown pages and arbitrary `.md` imports out of v1.
- Have the Sätteri plugin replace registered directives with internal encoded sentinel elements. Attributes are retained as strings, bare attributes become `true`, and `id`/`class` shorthand passes through as props.
- Parse the sentinel stream into nested static-HTML/component segments and generate an Astro content module using `createComponent` and `renderComponent`. Container, leaf-label, and inline children become the default slot.
- Preserve frontmatter, heading metadata, syntax highlighting, local/remote image optimization, component styles, scripts, and framework renderer behavior. Internal sentinels must never appear in emitted HTML.
- Fail unknown directives with the name and original Markdown location. Registry values are imported only when referenced by a document.
- Build the package with TypeScript into `dist`, add workspace scripts for package build/test, and declare Astro/Sätteri compatibility through peer dependencies.

## Site Migration

- Register the four existing MDX components through `@matfire/astro-directives`.
- Rename every article from `.mdx` to `.md` and change the article collection glob accordingly.
- Replace component imports and JSX with directives:
  - `:::callout{type="warning"} … :::`
  - `::youtube{id="…"}`
  - `::stackblitz{id="…"}`
  - `::codesandbox{projectType="devbox" projectid="…"}`
- Remove the author-facing MDX integration and `@astrojs/mdx` dependency.
- Preserve the two currently untracked articles during migration and avoid rewriting article prose or fenced examples.

## Test Plan

- Unit-test all three directive forms, nested directives, Markdown slot content, shorthand and bare attributes, escaping, adjacent inline components, and import deduplication.
- Verify unknown names and malformed sentinel nesting produce source-located errors.
- Add an Astro fixture proving content collection rendering, component props and slots, scoped component CSS propagation, headings, syntax highlighting, and optimized Markdown images.
- Run type checking, package tests, and a production build of the fully migrated site; assert no sentinel markup or MDX imports remain.

## Assumptions

- v1 supports content collections only, not `.md` pages or direct Markdown imports.
- Props are directive literals only; JavaScript expressions and automatic number/JSON coercion are intentionally unsupported.
- Components receive one default slot; named slots are out of scope.
- Frontmatter `layout` behavior for standalone Markdown pages is out of scope.
- The package is prepared for publishing but will not be published as part of this work.
