# Shell arguments fixture

These commands pass CLI flags after the script name. The flags (`--reporter`,
`--coverage`, `-u`) are not script names and must not be flagged as errors.

## Test with a reporter flag

```bash
pnpm --filter @wafflefinance/fixture-app test --reporter verbose
```

## Test with coverage

```bash
pnpm --filter @wafflefinance/fixture-app test --coverage
```

## Lint with auto-fix

```bash
pnpm --filter @wafflefinance/fixture-app lint --fix
```

## Short flags are also not script names

```bash
pnpm --filter @wafflefinance/fixture-app test -u
```
