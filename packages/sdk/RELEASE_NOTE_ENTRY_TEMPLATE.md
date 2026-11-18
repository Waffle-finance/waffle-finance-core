# SDK Release Note Entry Template

> Use this when a PR changes anything under `packages/sdk`. Copy the block
> below into the PR description (or into `releases/vX.Y.Z.md` §6 "SDK
> changes" when the release notes are drafted — see
> [docs/RELEASE_NOTES_PROCESS.md](../../docs/RELEASE_NOTES_PROCESS.md)).
> This keeps a single, consistent per-change record that the release
> engineer can fold directly into the full release notes.

## Minimum entry fields

Every SDK-facing change must record:

| Field | Required | Notes |
|---|---|---|
| Export path | yes | e.g. `@wafflefinance/sdk/ethereum`, or `internal` if not publicly exported |
| Change type | yes | one of: `breaking` / `fix` / `feature` / `internal` (see below) |
| Stability tier | yes | `stable` / `transport-specific` / `internal` — per [README.md](./README.md) |
| Summary | yes | one sentence describing the behavior change |
| Migration guidance | only if `breaking` | before/after usage; omit field entirely otherwise |

### Change type definitions

- **breaking** — a removed export, a renamed export, or a changed type/
  signature that existing consumer code would fail to compile or behave
  differently against. Always requires migration guidance.
- **fix** — a bug fix that does not change the public API shape.
- **feature** — a new export or new capability that is additive and
  backward-compatible.
- **internal** — a change confined to `internal` stability tier code with
  no effect on `stable` or `transport-specific` exports.

`breaking` is always distinguishable from `fix`/`internal` by requiring the
migration guidance field — a release engineer scanning entries for risk
classification should never have to open the diff to tell them apart.

## Entry format

```markdown
### SDK: <short title>

- **Export path:** `@wafflefinance/sdk/<subpath>`
- **Change type:** breaking | fix | feature | internal
- **Stability tier:** stable | transport-specific | internal
- **Summary:** <one sentence>
- **Migration guidance:** <before/after snippet — omit if not breaking>
```

## Example (harmless sample change, not a real release)

```markdown
### SDK: rename `getOrderStatus` to `fetchOrderStatus`

- **Export path:** `@wafflefinance/sdk/coordinator`
- **Change type:** breaking
- **Stability tier:** stable
- **Summary:** `getOrderStatus` was renamed to `fetchOrderStatus` for naming
  consistency with other fetch-prefixed client methods; the old name is
  removed, not aliased.
- **Migration guidance:**

  ```ts
  // before
  import { getOrderStatus } from '@wafflefinance/sdk/coordinator';
  const status = await getOrderStatus(client, publicId);

  // after
  import { fetchOrderStatus } from '@wafflefinance/sdk/coordinator';
  const status = await fetchOrderStatus(client, publicId);
  ```
```

This convention agrees with, and does not replace,
[docs/RELEASE_NOTES_PROCESS.md](../../docs/RELEASE_NOTES_PROCESS.md) §6 and
the [.github/RELEASE_NOTES_TEMPLATE.md](../../.github/RELEASE_NOTES_TEMPLATE.md)
SDK table — this document defines the per-PR entry that feeds that table.
