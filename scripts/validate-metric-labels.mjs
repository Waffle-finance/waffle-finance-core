#!/usr/bin/env node
/**
 * Audit metric label names across coordinator, relayer and resolver.
 *
 * Bounded dimensions (chain, route, outcome, ...) are allowed. Identifiers
 * such as order IDs, wallet addresses, preimages and transaction signatures
 * are not: they create unbounded Prometheus cardinality and leak sensitive
 * values. The audit reports the offending metric name and file location.
 *
 * Usage: node scripts/validate-metric-labels.mjs [--root <repo-root>]
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const METRIC_FILES = [
  'coordinator/src/metrics.ts',
  'coordinator/src/backlog/backlog-metrics.ts',
  'coordinator/src/archival/archival-metrics.ts',
  'relayer/src/metrics.ts',
  'relayer/src/services/job-manager/metrics.ts',
  'resolver/src/metrics.ts',
];

/** Bounded label vocabulary used by the services (see docs/METRIC_LABEL_BUDGET.md). */
export const ALLOWED_LABELS = new Set([
  'action', 'chain', 'checkpoint', 'conflict_type', 'decision', 'direction',
  'error_type', 'event', 'event_type', 'failure_category', 'failure_reason',
  'fault_class', 'from', 'from_state', 'job', 'method', 'mismatch_type', 'mode',
  'mutation', 'name', 'network_mode', 'operation', 'outcome', 'path', 'phase',
  'priority', 'query_name', 'reason', 'recovered_to_state', 'recovery_type',
  'result', 'route', 'state', 'status', 'status_code', 'to', 'to_state',
  'transition', 'trigger', 'type', 'verdict',
]);

const FORBIDDEN_SEGMENTS = new Set([
  'id', 'order', 'orderid', 'wallet', 'address', 'preimage', 'secret',
  'hashlock', 'signature', 'tx', 'txhash', 'transaction', 'user', 'account',
  'pubkey', 'publickey',
]);

export const MAX_LABELS_PER_METRIC = 4;

/**
 * @returns {Array<{metric:string,file:string,label:string,problem:string}>}
 */
export function auditMetricLabels(root = resolve(HERE, '..')) {
  const violations = [];
  for (const relPath of METRIC_FILES) {
    const file = join(root, relPath);
    if (!existsSync(file)) {
      violations.push({ metric: '(file)', file: relPath, label: '-', problem: 'metric definition file is missing' });
      continue;
    }
    const source = readFileSync(file, 'utf8');
    const defRe = /new\s+(?:Counter|Gauge|Histogram|Summary)\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
    for (const match of source.matchAll(defRe)) {
      const block = match[1];
      const nameMatch = block.match(/\bname\s*:\s*['"`]([^'"`]+)['"`]/);
      const labelsMatch = block.match(/\blabelNames\s*:\s*\[([^\]]*)\]/);
      if (!nameMatch || !labelsMatch) continue;
      const metric = nameMatch[1];
      const line = source.slice(0, match.index).split('\n').length;
      const labels = labelsMatch[1]
        .split(',')
        .map((label) => label.trim().replace(/^['"`]|['"`]$/g, ''))
        .filter(Boolean);

      if (labels.length > MAX_LABELS_PER_METRIC) {
        violations.push({
          metric, file: `${relPath}:${line}`, label: '-',
          problem: `${labels.length} labels exceeds the budget of ${MAX_LABELS_PER_METRIC}`,
        });
      }
      for (const label of labels) {
        const segments = label.toLowerCase().split(/[_-]/).filter(Boolean);
        const identifier = segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment));
        if (identifier) {
          violations.push({
            metric, file: `${relPath}:${line}`, label,
            problem: 'high-cardinality or sensitive identifier label',
          });
        } else if (!ALLOWED_LABELS.has(label)) {
          violations.push({
            metric, file: `${relPath}:${line}`, label,
            problem: 'label is not in the documented bounded-dimension budget',
          });
        }
      }
    }
  }
  return violations;
}

export function formatViolations(violations) {
  return violations.map(
    (v) => `✗ metric "${v.metric}" (${v.file}): label "${v.label}" — ${v.problem}`
  ).join('\n');
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  let root = resolve(HERE, '..');
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--root' && process.argv[i + 1]) root = resolve(process.argv[i + 1]);
  }
  const violations = auditMetricLabels(root);
  if (violations.length) {
    console.error(`Metric label budget exceeded (${violations.length} violation(s)):\n${formatViolations(violations)}`);
    process.exit(1);
  }
  console.log(`✓ Metric label budget OK across ${METRIC_FILES.length} metric definition files.`);
}
