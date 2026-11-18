# Drift Detection Runbook

> **Last updated:** 2026-09-23
> **Maintainer:** Engineering / Platform team
> **Related docs:** [docs/QUALITY_GATE.md](QUALITY_GATE.md), [docs/OPERATIONS.md](OPERATIONS.md), [docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md](DEPLOYMENT_ROLLBACK_RUNBOOK.md), [contracts/docs/mainnet-deployment-checklist.md](../contracts/docs/mainnet-deployment-checklist.md)

Drift between deployed contract addresses, config values, documentation, and
runtime code is a high-risk failure mode in a multi-chain protocol. A coordinator
using the wrong contract address silently ignores all on-chain events. A doc
pointing at a nonexistent workflow gives operators false confidence. An env var
renamed in code but not in `env.example` blocks every new operator from starting.

This runbook defines the checks that catch drift **before** it reaches support or
production incidents, how to run them, and what to do when you find a mismatch.

---

## Table of Contents

- [Drift taxonomy](#drift-taxonomy)
- [Required checks before any deployment or upgrade](#required-checks-before-any-deployment-or-upgrade)
- [Comparing deployed addresses](#comparing-deployed-addresses)
- [Comparing config values and runtime behavior](#comparing-config-values-and-runtime-behavior)
- [Comparing docs against code and config](#comparing-docs-against-code-and-config)
- [Environment-specific examples](#environment-specific-examples)
  - [Testnet (Sepolia + Stellar testnet)](#testnet-sepolia--stellar-testnet)
  - [Devnet (Solana devnet)](#devnet-solana-devnet)
  - [Local development](#local-development)
- [Handling drift when not all checks can be completed](#handling-drift-when-not-all-checks-can-be-completed)
- [Correcting drift: resolution sequence](#correcting-drift-resolution-sequence)
- [Known drift at time of last audit](#known-drift-at-time-of-last-audit)

---

## Drift taxonomy

| Type | Example | Risk |
|---|---|---|
| **Address drift** | `deployments.testnet.json` has a different address than the coordinator's `ETH_HTLC_ESCROW_TESTNET` env var | Coordinator silently watches the wrong contract; events are never delivered |
| **Config drift** | `env.example` missing `ETHEREUM_RPC_URL`; code reads it and uses an undefined fallback | Operator's coordinator starts in degraded mode without realising |
| **Doc drift** | `coordinator/ops/RUNBOOK.md` documents port 3000; actual default is 3001 | On-call engineer curls the wrong endpoint; alert runbook commands fail silently |
| **ABI drift** | Soroban TypeScript bindings not regenerated after a redeploy | Coordinator and frontend silently use stale types; runtime errors only |
| **Schema drift** | Migration added in code; Postgres-specific variant missing; production DB on Postgres fails migration | Silent failure or hard crash on deploy |
| **Workflow drift** | Docs reference `.github/workflows/release.yml`; that file does not exist | Team believes CI is running checks that no longer exist |

---

## Required checks before any deployment or upgrade

Run all checks in the order listed. Each has a resolution path in
[Correcting drift: resolution sequence](#correcting-drift-resolution-sequence).

### 1. Address comparison

Compare the three layers that carry contract addresses:

```
deployments.<network>.json  ←→  env vars in coordinator/relayer/frontend  ←→  docs
```

```bash
# 1a. Print addresses from the deployment artifact
node -e "const d = require('./deployments.testnet.json'); console.log(JSON.stringify(d, null, 2))"

# 1b. Print addresses from environment / .env
grep -E "^(ETH_HTLC_ESCROW|SOROBAN_HTLC|ETH_RESOLVER_REGISTRY|SOROBAN_RESOLVER_REGISTRY)" .env

# 1c. Confirm the coordinator is using the right address at runtime
curl -s http://localhost:3001/health | jq '.contractAddresses'
```

If any of the three layers disagrees, **do not proceed** — resolve the mismatch
per [Correcting drift: resolution sequence](#correcting-drift-resolution-sequence).

### 2. Env var coverage check

Every variable read by the code must have a corresponding entry in `env.example`.

```bash
# Find all process.env.* reads in backend source
grep -rhoE "process\.env\.[A-Z_][A-Z0-9_]+" \
  coordinator/src relayer/src resolver/src packages/sdk/src packages/config/src \
  | sort -u > /tmp/code_vars.txt

# Find all documented keys in env.example
grep -oE "^[A-Z_][A-Z0-9_]+" env.example | sort -u > /tmp/example_vars.txt

# Diff: vars in code but missing from env.example
comm -23 /tmp/code_vars.txt /tmp/example_vars.txt
```

Also check frontend vars:

```bash
grep -rhoE "import\.meta\.env\.VITE_[A-Z_][A-Z0-9_]+" frontend/src \
  | sort -u > /tmp/frontend_vars.txt

# Compare against VITE_* lines in env.example
grep -oE "^VITE_[A-Z_][A-Z0-9_]+" env.example | sort -u > /tmp/example_vite_vars.txt
comm -23 /tmp/frontend_vars.txt /tmp/example_vite_vars.txt
```

Any variable appearing in the code diff but not in `env.example` is **undocumented
drift**. Add it to `env.example` with a comment in the same PR as the change.

### 3. Doc-to-file link check

Every markdown link in every `*.md` file must resolve to a real file.

```bash
# Find broken relative links in markdown files (requires Node)
node -e "
const fs = require('fs');
const path = require('path');
const root = '.';
const results = [];
function walk(dir) {
  for (const f of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, f.name);
    if (f.isDirectory() && !f.name.startsWith('.') && f.name !== 'node_modules') walk(p);
    else if (f.isFile() && f.name.endsWith('.md')) {
      const content = fs.readFileSync(p, 'utf8');
      for (const m of content.matchAll(/\[.*?\]\(([^)#]+)(#[^)]*)?\)/g)) {
        const target = m[1].split('#')[0];
        if (!target.startsWith('http') && target) {
          const abs = path.resolve(path.dirname(p), target);
          if (!fs.existsSync(abs)) results.push(p + ' → ' + target);
        }
      }
    }
  }
}
walk(root);
if (results.length) { console.error('Broken links:\n' + results.join('\n')); process.exit(1); }
else console.log('All links resolve.');
"
```

### 4. npm script reference check

Commands in docs must match the actual `scripts` blocks in `package.json` files.

```bash
# Find pnpm/npm script invocations across all markdown
grep -rhoE "pnpm (--filter [^ ]+ )?(run )?[a-z:_-]+" docs/ .github/ coordinator/docs/ resolver/ relayer/ \
  | sort -u > /tmp/doc_scripts.txt
cat /tmp/doc_scripts.txt
```

Cross-check manually against the relevant `package.json` files. Automated
tooling (`pnpm validate:docs`) is planned but not yet implemented — see
[docs/QUALITY_GATE.md](QUALITY_GATE.md).

### 5. Package version synchronization

Per `RELEASE_POLICY.md`, all published packages must move together.

```bash
node -e "
const pkgs = [
  'package.json',
  'packages/sdk/package.json',
  'packages/config/package.json',
  'frontend/package.json',
  'coordinator/package.json',
  'relayer/package.json',
  'resolver/package.json',
];
const fs = require('fs');
const versions = pkgs.map(p => {
  try { const j = JSON.parse(fs.readFileSync(p)); return {p, v: j.version}; }
  catch { return {p, v: 'MISSING'}; }
});
console.table(versions);
const unique = [...new Set(versions.map(v => v.v))];
if (unique.length > 1) { console.error('VERSION DRIFT detected'); process.exit(1); }
"
```

### 6. Deployment artifact sync

`deployments.testnet.json` contract addresses must match the env var comments in
`env.example` and the addresses listed in `README.md`.

```bash
node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('deployments.testnet.json'));
console.log('ETH HTLCEscrow:    ', d.ethereum?.contracts?.HTLCEscrow);
console.log('ETH ResolverRegistry:', d.ethereum?.contracts?.ResolverRegistry);
console.log('Stellar HTLC:      ', d.stellar?.contracts?.HTLC);
console.log('Stellar Registry:  ', d.stellar?.contracts?.ResolverRegistry);
"
# Compare output against README.md 'Deployed contracts' table and
# ETH_HTLC_ESCROW_TESTNET / SOROBAN_HTLC_TESTNET values in env.example.
```

### 7. Soroban bindings freshness

The SDK's TypeScript bindings must match the currently deployed Soroban HTLC.

```bash
# Get the on-chain IDL hash (requires stellar-cli)
stellar contract info --id "$SOROBAN_HTLC_TESTNET" --rpc-url "$SOROBAN_RPC_URL" | head -20

# Compare against the committed bindings
cat packages/sdk/src/soroban/htlc-bindings/index.ts | head -10
```

If the on-chain contract was redeployed without regenerating bindings, run:

```bash
stellar contract bindings typescript \
  --contract-id "$SOROBAN_HTLC_TESTNET" \
  --rpc-url "$SOROBAN_RPC_URL" \
  --network-passphrase "Test SDF Network ; September 2015" \
  --output-dir packages/sdk/src/soroban/htlc-bindings/
```

Then rebuild the SDK and verify tests still pass:

```bash
pnpm --filter @wafflefinance/sdk build
pnpm --filter @wafflefinance/sdk test
```

### 8. ABI and interface compatibility check

Run the upgrade check script before any contract upgrade to confirm ABI
compatibility:

```bash
pnpm --filter @wafflefinance/contracts exec hardhat run scripts/check-upgrade.ts --network sepolia
```

Any removed function is a breaking change — resolve it before proceeding.

### 9. Runtime health check

After any deployment or configuration change, confirm the coordinator and
relayer report all dependencies healthy:

```bash
curl -s http://localhost:3001/readyz | jq '.'
curl -s http://localhost:8080/readyz | jq '.'
```

Both should return `status: "ok"` (or `startup_phase: "ready"` for the
coordinator). A `503` or `degraded` status means a dependency (RPC, DB, or
contract address) is misconfigured.

---

## Comparing deployed addresses

### Step-by-step comparison

```
Source A: deployments.<network>.json (written by deploy.ts)
Source B: .env or environment (read by runtime services)
Source C: README.md "Deployed contracts" table (read by humans)
Source D: coordinator /health response (live runtime)
```

**1. Read Source A:**

```bash
node -e "
const d = require('./deployments.testnet.json');
console.log('ETH escrow:', d.ethereum?.contracts?.HTLCEscrow);
console.log('Stellar HTLC:', d.stellar?.contracts?.HTLC);
"
```

**2. Read Source B** (confirm active env or .env):

```bash
echo "ETH_HTLC_ESCROW_TESTNET=$ETH_HTLC_ESCROW_TESTNET"
echo "SOROBAN_HTLC_TESTNET=$SOROBAN_HTLC_TESTNET"
```

**3. Read Source C** (grep README):

```bash
grep -A2 "HTLCEscrow.*Sepolia" README.md
grep -A2 "wafflefinance-htlc" README.md
```

**4. Read Source D** (live coordinator):

```bash
curl -s http://localhost:3001/health | jq '.config // .'
```

Any mismatch across A, B, C, D is drift. Fix it using the
[resolution sequence](#correcting-drift-resolution-sequence).

---

## Comparing config values and runtime behavior

### Coordinator port

The coordinator's actual default port is `3001` (set in `packages/config/src/node.ts`).
`coordinator/ops/` runbooks historically documented port `3000`. Verify:

```bash
# What port is the coordinator config using?
grep -r "COORDINATOR_PORT\|3001\|3000" packages/config/src/node.ts coordinator/src/config.ts
```

If ops runbooks still reference port 3000, update them in the same PR.

### Chain listener startup mode

Listeners start lazily by default (TD-042). Verify whether eager startup is
enabled for the environment:

```bash
echo "COORDINATOR_EAGER_START=${COORDINATOR_EAGER_START:-not set, lazy mode active}"
```

If deploying to a network with active order flow, confirm whether lazy startup
is acceptable or whether `COORDINATOR_EAGER_START=true` should be set.

### Secret storage encryption

```bash
# Does SECRET_STORAGE_KEY have the required 32-byte (64-char hex) value?
[[ ${#SECRET_STORAGE_KEY} -eq 64 ]] && echo "OK" || echo "DRIFT: key missing or wrong length"
```

A missing or short key means preimages are stored in plaintext — this is a
critical operational gap on any environment handling real orders (see TD-041).

### Relayer safety deposit

```bash
# Is the ETH/USD price being read from the live cache or the hardcoded fallback?
grep -n "ETH_USD_PRICE\|3500\|getPriceSnapshot" relayer/src/index.ts | head -10
```

If `calculateDynamicSafetyDeposit` still uses the hardcoded `3500` constant
(TD-052), document this in your deployment notes as a known limitation.

---

## Comparing docs against code and config

### Metric names

The coordinator registers metrics via `prom-client`. If a metric is renamed in
code but not in the ops runbook or alert rules, alerts silently stop firing.

```bash
# Metrics registered in code
grep -rhoE "new (Counter|Gauge|Histogram|Summary)\(\{[^}]*name: '[^']+'" coordinator/src/ \
  | grep -oE "name: '[^']+'" | sort -u

# Metrics referenced in ops docs
grep -oE "coordinator_[a-z_]+" coordinator/ops/RUNBOOK.md coordinator/ops/coordinator-alerts.yml \
  | sort -u
```

Cross-check the two lists. Any metric in the alert rules but absent from the
code means the alert will never fire.

### Health endpoint routes

```bash
# Routes mounted in code
grep -rhoE "(app|router)\.(get|post)\(['\"/]+(health|healthz|readyz)[^'\"]*['\"]" \
  coordinator/src/server/ relayer/src/ resolver/src/ | sort -u

# Endpoints documented in HEALTH_DASHBOARD.md
grep -oE "GET /[a-z/]+" docs/HEALTH_DASHBOARD.md | sort -u
```

### CI workflow references

```bash
# Workflow files referenced in docs
grep -rhoE "\.github/workflows/[a-z-]+\.yml" docs/ .github/*.md | sort -u

# Workflow files that actually exist
ls .github/workflows/
```

Any workflow file referenced in docs but absent from `.github/workflows/` is
workflow drift — either create the file or update the docs to reflect reality.

---

## Environment-specific examples

### Testnet (Sepolia + Stellar testnet)

#### Expected state

| Check | Expected value |
|---|---|
| `deployments.testnet.json` ethereum chain ID | `11155111` |
| `ETH_HTLC_ESCROW_TESTNET` env var | Matches `deployments.testnet.json`.ethereum.contracts.HTLCEscrow |
| `SOROBAN_HTLC_TESTNET` env var | Matches `deployments.testnet.json`.stellar.contracts.HTLC |
| Coordinator `/readyz` | `status: "ok"` or `startup_phase: "ready"` |
| `NETWORK_MODE` | `testnet` |
| `VITE_MAINNET_ENABLED` | `false` |

#### Quick verification

```bash
# Confirm chain ID matches
curl -s -X POST "$SEPOLIA_RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' | jq '.result'
# Expected: "0xaa36a7" (11155111 in hex)

# Confirm contract code exists at the deployed address
curl -s -X POST "$SEPOLIA_RPC_URL" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"$ETH_HTLC_ESCROW_TESTNET\",\"latest\"],\"id\":1}" \
  | jq '.result' | wc -c
# Any value above 4 (i.e., not "0x") means contract code is present.

# Confirm Stellar HTLC exists on testnet
curl -s "https://soroban-testnet.stellar.org" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"getContractData\",\"params\":{\"contract\":\"$SOROBAN_HTLC_TESTNET\",\"key\":\"AAAABgAAAAM=\",\"durability\":\"persistent\"},\"id\":1}" \
  | jq '.error // "contract exists"'
```

#### Config mismatch example

```
Symptom: Coordinator logs show no OrderCreated events despite confirmed on-chain transactions.
Likely cause: ETH_HTLC_ESCROW_TESTNET points at an old deployment (address drift).

Resolution:
1. grep "ETH_HTLC_ESCROW_TESTNET" .env
2. node -e "const d = require('./deployments.testnet.json'); console.log(d.ethereum.contracts.HTLCEscrow)"
3. If they differ → update .env to match deployments.testnet.json
4. Restart coordinator
5. Verify listener catches up: curl -s http://localhost:3001/metrics | grep listener_lag
```

### Devnet (Solana devnet)

#### Expected state

| Check | Expected value |
|---|---|
| `SOLANA_HTLC_PROGRAM` env var | Non-empty, non-placeholder Anchor program ID |
| `SOLANA_RPC_URL` | Reachable devnet endpoint |
| Coordinator SolanaListener | Enabled (log: no "Solana listener disabled" message) |

#### Quick verification

```bash
# Confirm Solana program exists on devnet
solana program show "$SOLANA_HTLC_PROGRAM" --url devnet 2>&1 | head -5

# Confirm coordinator Solana listener is active
curl -s http://localhost:3001/health | jq '.listeners'
# Should include "solana" with a recent last_block value.
```

#### Config mismatch example

```
Symptom: Coordinator logs show "SOLANA_HTLC_PROGRAM not configured - Solana listener disabled"
         even though the program is deployed on devnet.

Likely cause: SOLANA_HTLC_PROGRAM is unset or still contains the placeholder value.

Resolution:
1. echo "SOLANA_HTLC_PROGRAM=$SOLANA_HTLC_PROGRAM"
2. If blank or "PLACEHOLDER": set it to the real Anchor program ID in .env
3. Restart coordinator.
4. Verify: curl -s http://localhost:3001/health | jq '.listeners.solana'
```

### Local development

#### Expected state

| Check | Expected value |
|---|---|
| `DATABASE_URL` | `file:./wafflefinance.db` (SQLite) |
| `NETWORK_MODE` | `testnet` |
| Contract addresses | From `deployments.testnet.json` (pointing at Sepolia) |
| `SECRET_STORAGE_KEY` | Set to a 64-char hex value (even for local dev) |

#### Config mismatch example

```
Symptom: Coordinator starts but /readyz returns 503 "secret_storage_key_missing"

Likely cause: SECRET_STORAGE_KEY is not set in .env (TD-041).

Resolution:
1. Generate a key: openssl rand -hex 32
2. Add to .env: SECRET_STORAGE_KEY=<generated value>
3. Restart coordinator.
4. Verify: curl -s http://localhost:3001/readyz | jq '.'
```

---

## Handling drift when not all checks can be completed

Some checks require a live network (RPC connectivity) or deployed services.
Use this decision table when checks cannot be completed:

| Check | Can be skipped? | Condition to skip | Required mitigation |
|---|---|---|---|
| Address comparison (section 1) | No | — | Block deployment until resolved |
| Env var coverage (section 2) | Yes | Readonly doc review only | Document any undiscovered vars in the PR description; file a follow-up issue |
| Doc-to-file links (section 3) | Yes | No doc changes in the PR | Run it on the first PR that touches docs after the unblocked deploy |
| npm script references (section 4) | Yes | No script changes | Same as above |
| Package version sync (section 5) | No for releases, yes for hotfixes | Hotfix PR targeting a single package | Include version sync as the immediate follow-up PR |
| Deployment artifact sync (section 6) | No | — | Block deployment until resolved |
| Soroban bindings (section 7) | Only if Soroban contract unchanged | Confirm no new Soroban deployment since last bindings regen | Add a comment in the PR confirming the check was waived and why |
| ABI compatibility (section 8) | Only if contract unchanged | No Solidity changes in the PR | — |
| Runtime health check (section 9) | No | — | Do not declare a deployment complete until this passes |

**Minimum mandatory checks before any deployment:**

1. Address comparison (check 1)
2. Deployment artifact sync (check 6)
3. Runtime health check after deploy (check 9)

If checks 2–8 cannot be completed, document the gap explicitly in your
deployment PR description and file a follow-up issue to track it.

---

## Correcting drift: resolution sequence

When drift is found, follow this sequence to minimise risk:

### Address drift

1. Identify the authoritative source for the environment:
   - For freshly deployed contracts: `deployments.<network>.json` is authoritative.
   - For running production environments: the currently working env var value is authoritative until you can verify the on-chain address is correct.
2. Update all dependent layers (env vars, docs, README) to match the authoritative source.
3. If the coordinator or relayer is running with the wrong address, restart the service after updating env vars. The reconciler will backfill any missed events on restart.
4. Run a targeted validation: `pnpm --filter @wafflefinance/contracts exec hardhat run scripts/validate-deployment.ts --network <network>`

### Config drift (missing/renamed env vars)

1. Add the missing entry to `env.example` with an inline comment describing whether it is required or optional, and what the default is if unset.
2. If the var was renamed in code but not in docs, update all references (ops runbooks, development docs, INTEGRATION_GUIDE).
3. Run check 2 again to confirm no new gaps.

### Doc drift (broken links, stale workflow references)

1. If the linked file should exist but doesn't (e.g. a workflow file): either create the file, or update the doc to reflect reality.
2. If the linked file was moved: update the link.
3. Run the doc-to-file link check again to confirm clean.
4. Add the corrected doc to the same PR as the code change that caused the drift.

### ABI / bindings drift

1. Determine which side is stale: code (if just redeployed) or docs (if contract hasn't changed).
2. If contract was just redeployed:
   - Regenerate Soroban TS bindings (see check 7 above).
   - Update `deployments.<network>.json` with the new addresses.
   - Update `env.example` comments.
3. If doc drifted independently: update the doc; no code changes needed.

### Port / endpoint drift

1. Confirm the actual default via `packages/config/src/node.ts` or the service's `config.ts`.
2. Update all ops runbooks in a single PR (`coordinator/ops/RUNBOOK.md`, `coordinator/ops/README.md`, `coordinator/ops/QUICK_REFERENCE.md`, `docs/OPERATIONS.md`).
3. If Prometheus scrape config (`coordinator/ops/prometheus.yml`) uses the wrong port, update it and redeploy Prometheus.

---

## Known drift at time of last audit

The following items were identified in the initial quality-gate audit
(2026-07-26) and are tracked in [docs/QUALITY_GATE.md](QUALITY_GATE.md).
They are listed here as context for operators, not as a complete current state
— see the quality gate doc and [docs/TECHNICAL_DEBT.md](TECHNICAL_DEBT.md) for
up-to-date status.

| # | Type | Description | Status |
|---|---|---|---|
| D-001 | Config drift | 16 env vars read in code but absent from `env.example` | Open |
| D-002 | Workflow drift | Docs reference `release.yml`, `ci.yml`, `contracts.yml` which do not exist in `.github/workflows/` | Open |
| D-003 | Doc drift | `coordinator/ops/` runbooks document coordinator port as `3000`; actual default is `3001` | Open |
| D-004 | Config drift | `VITE_ENABLE_MOCK_DATA` read in frontend but absent from `env.example` | Open |
| D-005 | Bindings drift | Soroban TS bindings require manual regeneration after each contract redeploy (no automation) | Open (TD-020) |

When an item is resolved, update the `Status` column here and in QUALITY_GATE.md.
