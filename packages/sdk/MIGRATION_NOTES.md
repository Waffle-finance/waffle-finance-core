# SDK Migration Notes: Deprecated Exports

This document tracks SDK exports that are kept for backward compatibility
but are no longer the preferred way to access that functionality. None of
the exports below have been removed — this is a migration aid, not a
removal notice. Removal (if it ever happens) will be announced separately
via the SDK release note process (see
[RELEASE_NOTE_ENTRY_TEMPLATE.md](./RELEASE_NOTE_ENTRY_TEMPLATE.md)) with a
`breaking` entry and migration guidance ahead of time.

## Deprecated exports

| Deprecated export | Module | Preferred replacement | Removal status |
|---|---|---|---|
| `SUPPORTED_DIRECTIONS` | `@wafflefinance/sdk/coordinator` | `listRoutesForNetwork` / `isSupportedRoute` from `@wafflefinance/sdk/routes` | Not removed — kept as a compatibility re-export of the route registry |
| `DIRECTION_CHAINS` | `@wafflefinance/sdk/coordinator` | `LIVE_DIRECTION_CHAINS` from `@wafflefinance/sdk/routes` | Not removed — kept as a compatibility re-export of the route registry |

## Why these are deprecated

Both exports predate the route registry (`@wafflefinance/sdk/routes`),
which is now the single source of truth for route identity — a route is a
direction *and* a token group *and* a bridge mode *and* a quote model, not
direction alone (see [ROUTE_REGISTRY.md](./ROUTE_REGISTRY.md)). The two
exports above are still correct (they are literally re-exported from the
registry's own constants — see `src/coordinator/validation.ts`), but code
relying on direction alone cannot express everything the registry can, so
new code should go through the registry functions directly.

## Migration guidance

### `SUPPORTED_DIRECTIONS` → `listRoutesForNetwork` / `isSupportedRoute`

```ts
// before
import { SUPPORTED_DIRECTIONS } from '@wafflefinance/sdk/coordinator';
const ok = SUPPORTED_DIRECTIONS.includes(direction);

// after
import { isSupportedRoute } from '@wafflefinance/sdk/routes';
const ok = isSupportedRoute({ direction, tokenGroup, network });
```

### `DIRECTION_CHAINS` → `LIVE_DIRECTION_CHAINS`

```ts
// before
import { DIRECTION_CHAINS } from '@wafflefinance/sdk/coordinator';
const { src, dst } = DIRECTION_CHAINS[direction];

// after
import { LIVE_DIRECTION_CHAINS } from '@wafflefinance/sdk/routes';
const { src, dst } = LIVE_DIRECTION_CHAINS[direction];
```

## Compatibility policy

These exports remain available and functionally correct — they are backed
by the same registry constants as their replacements, not frozen copies —
so there is no behavior drift risk from migrating on your own schedule.
