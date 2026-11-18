# Documentation Examples: Type-Check Conventions

> **Last updated:** 2026-11-19  
> **Maintainer:** SDK team  
> **Related docs:** [`packages/sdk/tsconfig.typecheck.json`](../packages/sdk/tsconfig.typecheck.json), [`docs/QUALITY_GATE.md`](QUALITY_GATE.md)

Code examples in SDK documentation are compiled against the built SDK types on
every run of `pnpm --filter @wafflefinance/sdk typecheck`.  This catches renamed
or removed public symbols before they silently mislead an integrator.

---

## How it works

The SDK ships a second TypeScript configuration, `tsconfig.typecheck.json`, that
includes both `src/**/*.ts` and `examples/**/*.ts` with `noEmit: true`.  The
`typecheck` script in `packages/sdk/package.json` runs:

```bash
tsc --noEmit -p tsconfig.typecheck.json
```

Because `examples/` imports from `../src/…`, the check compiles each example
against the current source tree.  A renamed export in `src/` causes a type error
in the example, which fails the check and fails CI before the rename lands in a
published package.

---

## Where examples live

All checkable SDK examples go in `packages/sdk/examples/`.  The directory
currently contains:

| File | What it demonstrates |
|---|---|
| `announce-and-track-order.ts` | Coordinator client + OrderSubscriber lifecycle |
| `secrets-walkthrough.ts` | Secret generation, hashing, and verification |
| `asset-resolution.ts` | Cross-chain asset resolver helpers |
| `error-handling.ts` | SDK error classification and retry logic |

Each file is a valid TypeScript module that exports its functions.  It is also
exercised by `packages/sdk/test/examples.test.ts`, which imports the exports and
calls them against test doubles to confirm runtime behaviour matches the
documented API shape.

---

## Marker convention: public vs illustrative examples

Not every code sample in a doc needs to compile against the SDK.  Prose
explanations, partial snippets, and pseudocode are **illustrative** — they
explain a concept, not a runnable call.  Only **public API examples** are checked.

### Public API examples (checked)

A public API example:

- Imports only from `@wafflefinance/sdk/*` export paths (or `../src/…` inside
  the `packages/sdk/examples/` directory).
- Calls a stable or transport-specific export (see stability tiers in
  `packages/sdk/README.md`).
- Lives as a `.ts` file under `packages/sdk/examples/`.
- Is listed in this document's table above.

When you add a new public API example:

1. Create `packages/sdk/examples/<descriptive-name>.ts`.
2. Import from the `../src/…` subpath (not from the built `dist/`).
3. Export at least one function so `test/examples.test.ts` can call it.
4. Add an entry to the table in this document.
5. Add a test call in `packages/sdk/test/examples.test.ts`.

### Illustrative snippets (not checked)

An illustrative snippet is any code sample in a `.md` file that:

- Shows a concept or partial flow rather than a complete, runnable call.
- Uses pseudocode, placeholder variable names, or omitted imports.
- Demonstrates shell commands, config values, or non-SDK code.

**How to mark an illustrative snippet in Markdown:**

Add the `<!-- @doc-example: illustrative -->` comment immediately before the
fenced code block:

~~~markdown
<!-- @doc-example: illustrative -->
```typescript
// Pseudocode — illustrative only, not type-checked
const order = await coordinatorClient.announceOrder({ ... });
```
~~~

The `<!-- @doc-example: illustrative -->` marker signals that this block is
intentionally not compiled.  Any fenced TypeScript block in a Markdown doc that
lacks this marker and imports from `@wafflefinance/sdk` will be flagged by a
future doc-drift check (see `docs/QUALITY_GATE.md` check #8) as a candidate for
promotion to a checked example.

---

## Running the check

```bash
# Type-check all SDK source, examples, and tests:
pnpm --filter @wafflefinance/sdk typecheck

# Or from the workspace root:
pnpm validate:examples
```

The check runs as part of the release verification script
(`scripts/verify-release-locally.sh`).

---

## What failure means

A type error in `examples/` means one of:

1. **A public symbol was renamed or removed** — the example references the old
   name.  Update the example (and the release notes SDK section) to reflect the
   new name.

2. **A type signature changed** — a parameter or return type no longer matches.
   Update the example to use the new signature and document the change in the
   release notes.

3. **The example imports a path that no longer exists** — an export subpath was
   removed or reorganised.  Update the import and document the breaking change.

Do not suppress type errors with `@ts-ignore` in example files.  If a snippet is
intentionally incomplete, move it to an illustrative Markdown snippet instead.

---

## Stability tiers

Examples should only use **stable** or **transport-specific** exports.  Using
**internal** exports in examples is a signal the example should be rewritten
against a stable surface.

| Tier | Description | Example export |
|---|---|---|
| `stable` | Public API, semver-protected | `@wafflefinance/sdk/coordinator` |
| `transport-specific` | Chain-specific, stable per-chain | `@wafflefinance/sdk/ethereum` |
| `internal` | Private implementation detail | `@wafflefinance/sdk/internal/fixtures` |

See `packages/sdk/RELEASE_NOTE_ENTRY_TEMPLATE.md` for how to record a stability
tier when adding a new export to the SDK.
