#!/usr/bin/env node
/**
 * Post-deployment smoke check for coordinator, relayer and resolver.
 *
 * Probes /health and /readyz on each service with a bounded timeout, validates
 * the health contract, and summarises per-chain dependencies. Output never
 * contains API keys or credential-bearing URLs: only URL origins are printed.
 *
 * Config (in order of precedence):
 *   SMOKE_CONFIG=path/to/smoke.json  { "services": { "coordinator": { "baseUrl": "..." }, ... } }
 *   COORDINATOR_URL, RELAYER_URL, RESOLVER_URL environment variables
 *   defaults: http://localhost:3001, :3002, :3003
 * Optional SMOKE_TIMEOUT_MS (default 5000) and SMOKE_REQUIRED_CHAINS
 * (comma-separated; default ethereum,soroban,stellar,solana).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_DEFAULTS = {
  coordinator: 'http://localhost:3001',
  relayer: 'http://localhost:3002',
  resolver: 'http://localhost:3003',
};

const CHAIN_NAMES = ['ethereum', 'soroban', 'stellar', 'solana'];

/** Strip credentials, query strings and paths — never reveal a secret-bearing URL. */
export function safeOrigin(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.origin;
  } catch {
    return '<invalid-url>';
  }
}

function redact(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[?&][^=\s]+=[^\s&]+/g, '?redacted=1')
    .replace(/\b(sk|apikey|api_key|token|secret|key)-?[A-Za-z0-9_-]{8,}\b/gi, '[redacted]');
}

export function loadConfig(env = process.env) {
  const config = {};
  if (env.SMOKE_CONFIG) {
    const path = resolve(env.SMOKE_CONFIG);
    if (!existsSync(path)) throw new Error(`SMOKE_CONFIG file not found: ${path}`);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    for (const [name, value] of Object.entries(parsed.services ?? {})) {
      config[name] = { baseUrl: value.baseUrl ?? value.url };
    }
  }
  for (const name of Object.keys(SERVICE_DEFAULTS)) {
    const fromEnv = env[`${name.toUpperCase()}_URL`];
    if (fromEnv) config[name] = { baseUrl: fromEnv };
    config[name] ??= { baseUrl: SERVICE_DEFAULTS[name] };
  }
  const timeoutMs = Number(env.SMOKE_TIMEOUT_MS ?? 5000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('SMOKE_TIMEOUT_MS must be positive');
  const requiredChains = (env.SMOKE_REQUIRED_CHAINS ?? CHAIN_NAMES.join(','))
    .split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  return { services: config, timeoutMs, requiredChains };
}

async function probe(baseUrl, path, timeoutMs, fetchImpl) {
  const safe = `${safeOrigin(baseUrl)}${path}`;
  try {
    const response = await fetchImpl(new URL(path, baseUrl).toString(), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json();
    if (typeof body !== 'object' || body === null) throw new Error('expected a JSON object');
    return { status: response.status, body, safe };
  } catch (err) {
    const reason = redact(err instanceof Error ? err.message : String(err));
    throw new Error(`${safe} request failed: ${reason}`);
  }
}

function chainDependencies(checks) {
  const chains = {};
  for (const check of checks ?? []) {
    if (typeof check?.name !== 'string') continue;
    const name = check.name.toLowerCase();
    const chain = CHAIN_NAMES.find((c) => name.includes(c));
    if (!chain) continue;
    chains[chain] = chains[chain] === false || check.ok === false ? false : Boolean(check.ok);
  }
  return chains;
}

function validate(service, health, ready) {
  const problems = [];
  const expectedHealthStatus = {
    coordinator: ['ok', 'healthy'],
    relayer: ['ok', 'healthy', 'degraded'],
    resolver: ['ok', 'healthy', 'degraded'],
  }[service];
  if (!expectedHealthStatus.includes(health.body.status)) {
    problems.push(`/health status "${redact(String(health.body.status))}" is not one of ${expectedHealthStatus.join(', ')}`);
  }
  if (!('uptime' in health.body)) problems.push('/health is missing required field "uptime"');
  if (!Array.isArray(ready.body.checks)) {
    problems.push('/readyz is missing required array field "checks"');
  }
  if (ready.status !== 200 || ready.body.status !== 'ok') {
    const failed = (ready.body.checks ?? []).filter((c) => c?.ok === false).map((c) => redact(String(c.name)));
    const degraded = (ready.body.degradedServices ?? []).map((d) => redact(String(d)));
    problems.push(
      `/readyz returned HTTP ${ready.status} status="${redact(String(ready.body.status))}"` +
      (failed.length ? `; failing checks: ${failed.join(', ')}` : '') +
      (degraded.length ? `; degraded services: ${degraded.join(', ')}` : '')
    );
  }
  return problems;
}

/** @returns {Promise<{ok:boolean, results:Array<object>, problems:string[]}>} */
export async function runSmokeCheck(config, fetchImpl = fetch) {
  const problems = [];
  const results = [];

  for (const [service, { baseUrl }] of Object.entries(config.services)) {
    const diagnostics = [];
    let chains = {};
    try {
      const [health, ready] = await Promise.all([
        probe(baseUrl, '/health', config.timeoutMs, fetchImpl),
        probe(baseUrl, '/readyz', config.timeoutMs, fetchImpl),
      ]);
      diagnostics.push(...validate(service, health, ready));
      chains = chainDependencies(ready.body.checks);
      for (const chain of config.requiredChains) {
        if (chain in chains && chains[chain] === false) diagnostics.push(`chain dependency ${chain} is unhealthy`);
      }
    } catch (err) {
      diagnostics.push(err instanceof Error ? err.message : String(err));
    }
    if (diagnostics.length) problems.push(...diagnostics.map((d) => `${service}: ${d}`));
    results.push({ service, origin: safeOrigin(baseUrl), chains, ok: diagnostics.length === 0, diagnostics });
  }
  return { ok: problems.length === 0, results, problems };
}

export function formatReport(report) {
  const lines = ['Deployment health smoke check'];
  for (const r of report.results) {
    const chainSummary = Object.entries(r.chains).map(([name, ok]) => `${name}=${ok ? 'ok' : 'unhealthy'}`).join(' ');
    lines.push(`${r.ok ? 'PASS' : 'FAIL'} ${r.service} (${r.origin})${chainSummary ? ` chains: ${chainSummary}` : ''}`);
    for (const d of r.diagnostics) lines.push(`  - ${d}`);
  }
  return lines.join('\n');
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const report = await runSmokeCheck(loadConfig());
    console.log(formatReport(report));
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(`Deployment smoke check configuration error: ${redact(err instanceof Error ? err.message : String(err))}`);
    process.exit(2);
  }
}
