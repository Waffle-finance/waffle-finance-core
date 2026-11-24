/**
 * Deep-import failure fixture.
 *
 * This file intentionally imports from an internal SDK path that is NOT
 * listed in package.json#exports.  It must FAIL to type-check.
 *
 * HOW TO RUN
 * ----------
 * The check scripts expect this file to produce a type error:
 *
 *   pnpm --filter @wafflefinance/sdk exec tsc --noEmit -p tsconfig.consumer-dist.json 2>&1 \
 *     | grep deep-import.consumer.ts
 *   # expect: error TS2307 (Cannot find module) or TS2305 (no exported member)
 *
 * If tsc reports NO error for this file, the consumer validation pipeline is
 * broken — a deep import that should be blocked is being allowed.
 *
 * The validate:consumer script in package.json inverts the exit code for this
 * file so CI fails when the error is absent.
 */

// @ts-expect-error — this internal path is not in package.json#exports and
// must not be importable by consumers.
import { openDatabase } from "@wafflefinance/sdk/persistence/db";

export {};
