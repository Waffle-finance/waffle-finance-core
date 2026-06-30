# Frontend maintainability linting

Shared React components in `src/components` are intentionally kept small. ESLint
now enforces the following targeted limits for that folder:

- `max-lines`: 450 non-comment, non-blank lines per file
- `max-statements`: 80 statements per function
- `complexity`: 20 cyclomatic-complexity points per function

When a component approaches these limits, move route-specific business logic into
`src/features/<feature>` hooks/helpers and split repeated UI into smaller
presentational components. `src/components/BridgeForm.tsx` is a thin public
boundary; the bridge implementation lives under `src/features/bridge` so future
changes have a clearer feature-owned home instead of growing a shared component.
