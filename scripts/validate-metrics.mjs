#!/usr/bin/env node
/**
 * scripts/validate-metrics.mjs
 *
 * Static consistency check between metric names registered in the coordinator
 * application code and the operational artifacts that describe or consume
 * them (Grafana dashboards, Prometheus scrape/alerts config, and runbooks).
 *
 * A rename in code that is not reflected in alerts/dashboards/docs would
 * otherwise silently weaken incident detection. This script fails the build
 * with an actionable message naming the offending metric and artifact.
 *
 * Usage:
 *   node scripts/validate-metrics.mjs [--root <repo-root>]
 *
 * Exit codes:
 *   0 - all checks passed
 *   1 - one or more consistency failures
 *   2 - unexpected error (missing files, parse failure, etc.)
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Metrics that are intentionally NOT required to appear in alert rules.
 * Each entry must document *why* it is excluded so the list stays honest.
 *
 * Keys are the registered metric name (without label suffixes).
 */
const ALERT_EXCLUSIONS = new Map([
  // High-cardinality / informational metrics that are useful on dashboards
  // but would create noisy or expensive alert rules.
  ['coordinator_http_request_duration_seconds', 'latency histogram; alerted via SLO burn-rate recording rules instead'],
  ['coordinator_http_requests_total', 'raw request counter; alerted via derived error-ratio rules'],
  ['coordinator_worker_heartbeat_timestamp_seconds', 'liveness signal consumed by external watchdog, not Prometheus alerts'],
  ['coordinator_build_info', 'static build metadata gauge; never alertable'],
  ['coordinator_process_start_time_seconds', 'process metadata; never alertable'],
]);

/**
 * Metrics that are intentionally NOT required to appear in the operations
 * documentation metric list (e.g. internal/debug-only metrics).
 */
const DOC_EXCLUSIONS = new Map([
  ['coordinator_build_info', 'build metadata, not operationally documented'],
  ['coordinator_process_start_time_seconds', 'process metadata, not operationally documented'],
]);

/**
 * Suffixes appended by Prometheus client libraries to a base metric name.
 * A reference to `<base>_bucket`, `<base>_sum`, `<base>_count` is considered
 * a reference to `<base>` (label-only / aggregation variation).
 */
const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count'];

/**
 * Suffixes appended by Prometheus client libraries for summaries.
 */
const SUMMARY_SUFFIXES = ['_sum', '_count'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(msg) {
  console.error(`\u2717 ${msg}`);
  return false;
}

function ok(msg) {
  console.log(`\u2713 ${msg}`);
}

function readFileOrThrow(path) {
  if (!existsSync(path)) {
    throw new Error(`Required file not found: ${path}`);
  }
  return readFileSync(path, 'utf8');
}

/**
 * Strip a Prometheus histogram/summary suffix from a referenced metric name,
 * returning the base metric name. Non-suffixed names are returned unchanged.
 */
function stripAggregationSuffix(name) {
  for (const suffix of HISTOGRAM_SUFFIXES) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      return name.slice(0, -suffix.length);
    }
  }
  for (const suffix of SUMMARY_SUFFIXES) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      return name.slice(0, -suffix.length);
    }
  }
  return name;
}

/**
 * Normalize a metric reference: strip label selectors `{...}`, strip
 * aggregation suffixes, and trim whitespace.
 */
function normalizeReference(raw) {
  let name = raw.trim();
  // Remove label selectors: metric{foo="bar"} -> metric
  const braceIdx = name.indexOf('{');
  if (braceIdx !== -1) {
    name = name.slice(0, braceIdx);
  }
  // Remove any trailing punctuation that may have been captured.
  name = name.replace(/[.,;:)\]]+$/, '');
  return stripAggregationSuffix(name);
}

// ---------------------------------------------------------------------------
// 1. Parse registered metrics from coordinator/src/metrics.ts
// ---------------------------------------------------------------------------

/**
 * Extract registered metric names from TypeScript source.
 *
 * Recognized registration patterns:
 *   new Counter({ name: 'foo', ... })
 *   new Gauge({ name: 'foo', ... })
 *   new Histogram({ name: 'foo', ... })
 *   new Summary({ name: 'foo', ... })
 *   registerMetric('foo', ...)
 *   registerCounter('foo', ...) / registerGauge / registerHistogram
 *   createCounter('foo', ...) / createGauge / createHistogram
 *   .register({ name: 'foo', ... })
 *
 * Returns a Map<metricName, {kind, line}>.
 */
function parseRegisteredMetrics(source) {
  const metrics = new Map();
  const lines = source.split('\n');

  const patterns = [
    // new Counter({ name: 'foo' ... }) and friends
    {
      re: /\bnew\s+(Counter|Gauge|Histogram|Summary)\s*\(\s*\{[^}]*?\bname\s*:\s*['"`]([a-zA-Z_:][a-zA-Z0-9_:]*)['"`]/,
      kindFromGroup: 1,
      nameFromGroup: 2,
    },
    // registerMetric('foo', ...) / registerCounter('foo', ...) etc.
    {
      re: /\b(?:register|create)(?:Metric|Counter|Gauge|Histogram|Summary)\s*\(\s*['"`]([a-zA-Z_:][a-zA-Z0-9_:]*)['"`]/,
      kindFromGroup: null,
      nameFromGroup: 1,
    },
    // .register({ name: 'foo', ... })
    {
      re: /\.register\s*\(\s*\{[^}]*?\bname\s*:\s*['"`]([a-zA-Z_:][a-zA-Z0-9_:]*)['"`]/,
      kindFromGroup: null,
      nameFromGroup: 1,
    },
    // Generic object literal with name + help/type that looks like a metric def
    {
      re: /\bname\s*:\s*['"`]([a-zA-Z_:][a-zA-Z0-9_:]*)['"`]\s*,\s*(?:help|type|labelNames)\s*:/,
      kindFromGroup: null,
      nameFromGroup: 1,
    },
  ];

  lines.forEach((line, idx) => {
    for (const { re, kindFromGroup, nameFromGroup } of patterns) {
      const m = line.match(re);
      if (m) {
        const name = m[nameFromGroup];
        const kind = kindFromGroup ? m[kindFromGroup] : 'unknown';
        if (!metrics.has(name)) {
          metrics.set(name, { kind, line: idx + 1 });
        }
      }
    }
  });

  return metrics;
}

// ---------------------------------------------------------------------------
// 2. Parse metric references from operational artifacts
// ---------------------------------------------------------------------------

/**
 * Extract metric references from a Grafana dashboard JSON.
 * Walks the JSON tree looking for `expr` fields (PromQL) and `metric`
 * fields, then extracts metric identifiers from the expressions.
 */
function parseGrafanaDashboard(source, artifactPath) {
  const refs = new Map(); // metricName -> [locations]
  let json;
  try {
    json = JSON.parse(source);
  } catch (err) {
    throw new Error(`Failed to parse Grafana dashboard ${artifactPath}: ${err.message}`);
  }

  const expressions = [];
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') {
        if (key === 'expr' || key === 'query' || key === 'metric') {
          expressions.push({ expr: value, path: `${path}.${key}` });
        }
      } else {
        walk(value, `${path}.${key}`);
      }
    }
  };
  walk(json, '$');

  for (const { expr, path } of expressions) {
    for (const name of extractMetricNamesFromPromQL(expr)) {
      if (!refs.has(name)) refs.set(name, []);
      refs.get(name).push(`${artifactPath}${path}`);
    }
  }
  return refs;
}

/**
 * Extract candidate metric identifiers from a PromQL expression.
 * This is intentionally permissive: it collects identifier-like tokens and
 * filters out PromQL keywords, functions, and label names.
 */
function extractMetricNamesFromPromQL(expr) {
  const names = new Set();
  // Remove string literals to avoid matching label values.
  const withoutStrings = expr.replace(/(['"])(?:\\.|(?!\1).)*\1/g, '""');

  // Match identifiers that look like metric names (contain an underscore or
  // are known metric prefixes). We also capture names followed by `{` or `(`.
  const identRe = /\b([a-zA-Z_:][a-zA-Z0-9_:]*)\b/g;
  let m;
  while ((m = identRe.exec(withoutStrings)) !== null) {
    const token = m[1];
    const after = withoutStrings.slice(m.index + token.length).trimStart();
    // Skip if immediately followed by `(` -> function call.
    if (after.startsWith('(')) continue;
    // Skip if preceded by `by (` / `without (` label grouping.
    const before = withoutStrings.slice(0, m.index).trimEnd();
    if (/\b(by|without|on|ignoring|group_left|group_right)$/.test(before)) continue;
    // Skip label names inside selectors: token followed by `=` or `!=` or `=~`.
    if (/^(!?=~?)/.test(after)) continue;
    // Skip PromQL keywords and common functions.
    if (PROMQL_KEYWORDS.has(token)) continue;
    // Heuristic: metric names contain an underscore or are prefixed with a
    // known namespace. This avoids matching bare words.
    if (!token.includes('_') && !token.includes(':')) continue;
    names.add(token);
  }
  return names;
}

const PROMQL_KEYWORDS = new Set([
  'by', 'without', 'on', 'ignoring', 'group_left', 'group_right',
  'offset', 'bool', 'and', 'or', 'unless', 'sum', 'min', 'max', 'avg',
  'count', 'stddev', 'stdvar', 'topk', 'bottomk', 'quantile', 'count_values',
  'rate', 'irate', 'increase', 'delta', 'idelta', 'deriv', 'predict_linear',
  'histogram_quantile', 'label_replace', 'label_join', 'abs', 'ceil', 'floor',
  'round', 'clamp', 'clamp_max', 'clamp_min', 'time', 'vector', 'scalar',
  'absent', 'absent_over_time', 'avg_over_time', 'min_over_time',
  'max_over_time', 'sum_over_time', 'count_over_time', 'quantile_over_time',
  'stddev_over_time', 'stdvar_over_time', 'last_over_time', 'present_over_time',
  'changes', 'resets', 'sort', 'sort_desc', 'timestamp', 'day_of_month',
  'day_of_week', 'days_in_month', 'hour', 'minute', 'month', 'year',
]);

/**
 * Extract metric references from a Prometheus YAML file (scrape config or
 * alert rules). We do a lightweight text scan for `expr:` blocks and
 * `metric:`/`record:` names rather than pulling in a YAML parser.
 */
function parsePrometheusYaml(source, artifactPath) {
  const refs = new Map();
  const lines = source.split('\n');
  let inExpr = false;
  let exprIndent = 0;
  let exprBuffer = [];
  let exprStartLine = 0;

  const flushExpr = () => {
    if (exprBuffer.length > 0) {
      const expr = exprBuffer.join(' ');
      for (const name of extractMetricNamesFromPromQL(expr)) {
        if (!refs.has(name)) refs.set(name, []);
        refs.get(name).push(`${artifactPath}:${exprStartLine}`);
      }
    }
    exprBuffer = [];
    inExpr = false;
  };

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const indent = line.match(/^(\s*)/)[1].length;
    const trimmed = line.trim();

    if (inExpr) {
      if (trimmed === '' || indent > exprIndent) {
        exprBuffer.push(trimmed);
        return;
      }
      flushExpr();
    }

    // expr: ... (possibly multi-line)
    const exprMatch = line.match(/^\s*expr\s*:\s*(.*)$/);
    if (exprMatch) {
      const inline = exprMatch[1].trim();
      if (inline === '' || inline === '|' || inline === '>-' || inline === '|-' || inline === '>') {
        inExpr = true;
        exprIndent = indent;
        exprStartLine = lineNo;
        exprBuffer = [];
      } else {
        for (const name of extractMetricNamesFromPromQL(inline)) {
          if (!refs.has(name)) refs.set(name, []);
          refs.get(name).push(`${artifactPath}:${lineNo}`);
        }
      }
      return;
    }

    // record: <name> -> recording rule output, not a source metric reference.
    // metric: <name> -> metric_relabel / scrape config metric name.
    const metricMatch = line.match(/^\s*metric\s*:\s*['"]?([a-zA-Z_:][a-zA-Z0-9_:]*)['"]?\s*$/);
    if (metricMatch) {
      const name = metricMatch[1];
      if (!refs.has(name)) refs.set(name, []);
      refs.get(name).push(`${artifactPath}:${lineNo}`);
    }
  });

  if (inExpr) flushExpr();
  return refs;
}

/**
 * Extract metric references from a Markdown operations/alerting doc.
 * Looks for inline code spans and fenced code blocks containing metric-like
 * identifiers, plus bullet-list entries that name a metric.
 */
function parseMarkdownDoc(source, artifactPath) {
  const refs = new Map();
  const lines = source.split('\n');

  const addRef = (name, lineNo) => {
    if (!refs.has(name)) refs.set(name, []);
    refs.get(name).push(`${artifactPath}:${lineNo}`);
  };

  const metricTokenRe = /\b([a-zA-Z_:][a-zA-Z0-9_:]*)\b/g;

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    // Inline code spans: `metric_name` or `metric_name{label="x"}`
    const codeSpanRe = /`([^`]+)`/g;
    let m;
    while ((m = codeSpanRe.exec(line)) !== null) {
      const span = m[1];
      // Only treat spans that look like metric references (contain `_` and
      // optionally a label selector or PromQL-ish content).
      if (!span.includes('_')) continue;
      for (const name of extractMetricNamesFromPromQL(span)) {
        addRef(name, lineNo);
      }
    }

    // Bullet entries: "- coordinator_foo_total: description"
    const bulletMatch = line.match(/^\s*[-*]\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\b/);
    if (bulletMatch && bulletMatch[1].includes('_')) {
      addRef(bulletMatch[1], lineNo);
    }
  });

  return refs;
}

// ---------------------------------------------------------------------------
// 3. Comparison logic
// ---------------------------------------------------------------------------

function compareSets(registered, referenced, artifactLabel, exclusions) {
  const failures = [];
  const referencedBases = new Set();
  for (const name of referenced.keys()) {
    referencedBases.add(normalizeReference(name));
  }

  for (const [name, info] of registered) {
    if (exclusions.has(name)) continue;
    if (referencedBases.has(name)) continue;
    failures.push(
      `Metric "${name}" (registered at coordinator/src/metrics.ts:${info.line}) ` +
      `is missing from ${artifactLabel}. ` +
      `Either add a reference or document an intentional exclusion in scripts/validate-metrics.mjs.`
    );
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  let root = resolve(__dirname, '..');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) {
      root = resolve(args[i + 1]);
      i++;
    }
  }

  const metricsTsPath = join(root, 'coordinator/src/metrics.ts');
  const dashboardPath = join(root, 'coordinator/ops/grafana/dashboards/coordinator.json');
  const prometheusPath = join(root, 'coordinator/ops/prometheus.yml');
  const alertsPath = join(root, 'coordinator/ops/coordinator-alerts.yml');
  const operationsDocPath = join(root, 'docs/OPERATIONS.md');
  const alertingDocPath = join(root, 'docs/ALERTING.md');

  let registered;
  let dashboardRefs;
  let prometheusRefs;
  let alertsRefs;
  let operationsDocRefs;
  let alertingDocRefs;

  try {
    registered = parseRegisteredMetrics(readFileOrThrow(metricsTsPath));
    dashboardRefs = parseGrafanaDashboard(readFileOrThrow(dashboardPath), 'coordinator/ops/grafana/dashboards/coordinator.json');
    prometheusRefs = parsePrometheusYaml(readFileOrThrow(prometheusPath), 'coordinator/ops/prometheus.yml');
    alertsRefs = parsePrometheusYaml(readFileOrThrow(alertsPath), 'coordinator/ops/coordinator-alerts.yml');
    operationsDocRefs = parseMarkdownDoc(readFileOrThrow(operationsDocPath), 'docs/OPERATIONS.md');
    alertingDocRefs = parseMarkdownDoc(readFileOrThrow(alertingDocPath), 'docs/ALERTING.md');
  } catch (err) {
    console.error(`\u2717 ${err.message}`);
    process.exit(2);
  }

  if (registered.size === 0) {
    console.error('\u2717 No registered metrics found in coordinator/src/metrics.ts. Check the registration patterns.');
    process.exit(2);
  }

  console.log(`Found ${registered.size} registered metric(s) in coordinator/src/metrics.ts`);

  // Combine alert sources: Prometheus alerts + alerting doc.
  const alertRefs = new Map();
  for (const [name, locs] of alertsRefs) {
    if (!alertRefs.has(name)) alertRefs.set(name, []);
    alertRefs.get(name).push(...locs);
  }
  for (const [name, locs] of alertingDocRefs) {
    if (!alertRefs.has(name)) alertRefs.set(name, []);
    alertRefs.get(name).push(...locs);
  }

  // Combine documentation sources: operations doc + alerting doc.
  const docRefs = new Map();
  for (const [name, locs] of operationsDocRefs) {
    if (!docRefs.has(name)) docRefs.set(name, []);
    docRefs.get(name).push(...locs);
  }
  for (const [name, locs] of alertingDocRefs) {
    if (!docRefs.has(name)) docRefs.set(name, []);
    docRefs.get(name).push(...locs);
  }

  const failures = [];

  // Check 1: every registered metric must be referenced by an alert rule
  // (unless explicitly excluded).
  failures.push(...compareSets(registered, alertRefs, 'alert rules (coordinator/ops/coordinator-alerts.yml and docs/ALERTING.md)', ALERT_EXCLUSIONS));

  // Check 2: every registered metric must be referenced by the operations
  // documentation metric list (unless explicitly excluded).
  failures.push(...compareSets(registered, docRefs, 'operations documentation (docs/OPERATIONS.md and docs/ALERTING.md)', DOC_EXCLUSIONS));

  // Check 3: every registered metric should appear on the dashboard or in
  // scrape config. This is a softer check but still catches renames.
  const observabilityRefs = new Map();
  for (const src of [dashboardRefs, prometheusRefs]) {
    for (const [name, locs] of src) {
      if (!observabilityRefs.has(name)) observabilityRefs.set(name, []);
      observabilityRefs.get(name).push(...locs);
    }
  }
  failures.push(...compareSets(registered, observabilityRefs, 'Grafana dashboard (coordinator/ops/grafana/dashboards/coordinator.json) or Prometheus scrape config (coordinator/ops/prometheus.yml)', new Map()));

  if (failures.length > 0) {
    console.error(`\nMetric consistency check failed with ${failures.length} issue(s):\n`);
    for (const f of failures) {
      console.error(`  \u2717 ${f}`);
    }
    console.error('\nIntentional exclusions are documented in scripts/validate-metrics.mjs.');
    process.exit(1);
  }

  ok(`All ${registered.size} registered metric(s) are consistent with operational artifacts.`);
  process.exit(0);
}

main();