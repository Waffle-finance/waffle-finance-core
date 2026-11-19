# Valid commands fixture

All `pnpm --filter` invocations in this file reference known packages and
scripts that exist in the fixture workspace.

## Build the app

```bash
pnpm --filter @wafflefinance/fixture-app build
```

## Run tests

```bash
pnpm --filter @wafflefinance/fixture-app test
```

## Lint the app

```bash
pnpm --filter @wafflefinance/fixture-app lint
```

## Commands with arguments after the script name are still valid

The script name is `test`; `--reporter` is a shell argument, not a script name.

```bash
pnpm --filter @wafflefinance/fixture-app test --reporter verbose
```

## Placeholder syntax is not flagged

```bash
pnpm --filter <package-name> <script-name>
```

## pnpm built-in verbs after --filter are not flagged

```bash
pnpm --filter @wafflefinance/fixture-app install
pnpm --filter @wafflefinance/fixture-app exec tsc --noEmit
```
