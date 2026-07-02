# Linting and Formatting Policy

This document describes the linting and formatting policy for the WaffleFinance monorepo, including how to run checks locally and what's enforced in CI.

## Overview

The WaffleFinance monorepo uses a consistent linting and formatting policy across all packages to ensure code quality and maintainability. This policy covers:

- **TypeScript/JavaScript**: ESLint with shared configuration
- **Solidity**: Solhint for smart contracts
- **Rust**: rustfmt for Soroban contracts
- **Formatting**: Prettier for consistent code style

## Local Development

### Prerequisites

Ensure you have the following installed:
- Node.js >= 22.0.0
- pnpm >= 8.0.0
- Rust (for Soroban contracts)

### Installation

After cloning the repository, install dependencies:

```bash
pnpm install
```

This will also set up git hooks via husky automatically.

### Running Linters

#### Lint All TypeScript/JavaScript

```bash
# Lint all packages
pnpm run lint

# Lint a specific package
pnpm --filter @wafflefinance/sdk lint
pnpm --filter @wafflefinance/frontend lint
```

#### Lint Solidity

```bash
# Lint contracts
pnpm --filter @wafflefinance/contracts lint
```

#### Format Rust (Soroban)

```bash
# Format Rust code
cd soroban
cargo fmt
```

### Formatting Code

#### Format All Files

```bash
# Format all TypeScript, JavaScript, JSON, and Markdown files
pnpm run format

# Check formatting without modifying files
pnpm run format:check
```

#### Format Specific Files

```bash
# Format TypeScript/JavaScript
prettier --write "**/*.{ts,tsx}"

# Format JSON
prettier --write "**/*.json"

# Format Markdown
prettier --write "**/*.md"
```

### Pre-commit Hooks

The repository uses husky and lint-staged to automatically run linters and formatters on staged files before each commit. This ensures that only properly formatted and linted code is committed.

When you run `git commit`, the following will run automatically on staged files:

- TypeScript/JavaScript files: ESLint (with --fix) and Prettier
- JSON/Markdown files: Prettier
- Solidity files: Solhint (with --fix)
- Rust files: rustfmt

To skip pre-commit hooks (not recommended):

```bash
git commit --no-verify
```

## CI Enforcement

The CI pipeline enforces linting and formatting rules on every pull request and push to main branches. The CI workflow includes:

### Lint Job

Runs before tests and includes:

1. **TypeScript Linting**: Runs `pnpm run lint` across all packages
2. **Formatting Check**: Runs `pnpm run format:check` to ensure all files are properly formatted
3. **Solidity Linting**: Runs Solhint on all Solidity contracts
4. **Rust Formatting Check**: Runs `cargo fmt -- --check` in the soroban directory

If any of these checks fail, the CI will fail and the PR cannot be merged until the issues are resolved.

## Configuration Files

### ESLint

- **Shared Config**: `packages/eslint-config/` - Shared ESLint configuration for all packages
- **Root Config**: `.eslintrc.json` - Root ESLint configuration that extends the shared config
- **Package-specific**: Individual packages can override rules as needed

The shared ESLint config includes:
- TypeScript ESLint parser
- Recommended TypeScript rules
- Consistent type imports
- No unused variables (with `_` prefix exception)
- Strict equality checks

### Prettier

- **Config**: `.prettierrc` - Prettier configuration
- **Rules**:
  - Semi-colons: enabled
  - Quotes: single
  - Trailing commas: ES5
  - Print width: 100
  - Tab width: 2
  - Tabs: disabled (spaces)
  - Arrow parens: avoid
  - End of line: LF

### Solhint

- **Config**: `.solhint.json` - Solhint configuration for Solidity
- **Rules**:
  - Compiler version: ^0.8.0
  - Max line length: 120
  - Constructor syntax: enforced
  - Quotes: double
  - Indent: 4 spaces
  - Private variables with underscore prefix: enforced
  - State visibility: enforced
  - Function naming: mixedCase enforced

### Rustfmt

- **Config**: `soroban/rustfmt.toml` - Rustfmt configuration for Soroban contracts
- **Rules**:
  - Max width: 100
  - Tab spaces: 4
  - Newline style: Unix
  - Edition: 2021
  - Trailing comma: Vertical

### EditorConfig

- **Config**: `.editorconfig` - Editor-agnostic configuration
- **Rules**:
  - UTF-8 encoding
  - LF line endings
  - Space indentation (2 spaces for most files, 4 for Solidity/Rust)
  - Trailing whitespace trimmed
  - Final newline inserted

## Package-Specific Notes

### Frontend

The frontend package uses additional React-specific linting rules:
- React Hooks rules of hooks
- React exhaustive dependencies
- React refresh for component exports

### Contracts

The contracts package uses Solhint for Solidity linting. Run with:

```bash
pnpm --filter @wafflefinance/contracts lint
```

### Soroban

The Soroban contracts use rustfmt. Format with:

```bash
cd soroban
cargo fmt
```

Check formatting without modifying:

```bash
cd soroban
cargo fmt -- --check
```

## Troubleshooting

### ESLint Errors

If you encounter ESLint errors, you can:

1. **Auto-fix**: Many ESLint errors can be auto-fixed with `eslint --fix`
2. **Disable rules**: As a last resort, you can disable specific rules with comments:
   ```typescript
   // eslint-disable-next-line @typescript-eslint/no-explicit-any
   const foo: any = bar;
   ```

### Formatting Errors

If `format:check` fails, run `pnpm run format` to auto-fix formatting issues.

### Pre-commit Hook Failures

If pre-commit hooks fail:

1. Review the error messages
2. Run the specific linter/formatter manually to see all issues
3. Fix the issues or use `--fix` flags when available
4. Stage the fixes and try committing again

## Contributing

When contributing to the repository:

1. Run `pnpm run lint` and `pnpm run format:check` before pushing
2. Ensure all pre-commit hooks pass
3. If adding new linting rules, update this documentation
4. Keep the shared ESLint config in sync with project needs

## Future Improvements

Potential enhancements to the linting policy:

- Add TypeScript strict mode enforcement in CI
- Add complexity metrics and thresholds
- Add additional React-specific rules
- Add integration with IDEs for real-time feedback
- Add automated PR comments with linting suggestions
