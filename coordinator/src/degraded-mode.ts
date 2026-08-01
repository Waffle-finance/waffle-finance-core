import type { ReadinessCheck } from './server/routes/health.js';

export type DependencyHealthMode = 'healthy' | 'partially_healthy' | 'degraded';

export interface DependencyHealthReport {
  overall: DependencyHealthMode;
  degradedServices: string[];
  checks: ReadinessCheck[];
}

export interface RuntimeFallbackPolicy {
  mode: DependencyHealthMode;
  enabledListeners: Array<'ethereum' | 'soroban' | 'solana'>;
  disabledListeners: Array<'ethereum' | 'soroban' | 'solana'>;
  reasons: Record<string, string>;
}

const REQUIRED_SERVICE_NAMES = new Set(['database']);
const CHAIN_SERVICE_NAMES = new Set(['ethereum_rpc', 'soroban_rpc', 'solana_rpc']);
const SYNC_SERVICE_NAMES = new Set(['reconciliation', 'cache_alignment']);

function isDependencyCheck(check: ReadinessCheck): boolean {
  return !['startup_phase'].includes(check.name);
}

export function evaluateDependencyHealth(checks: ReadinessCheck[]): DependencyHealthReport {
  const degradedServices = checks
    .filter(check => isDependencyCheck(check) && !check.ok)
    .map(check => check.name)
    .filter(name => {
      if (REQUIRED_SERVICE_NAMES.has(name)) return true;
      if (CHAIN_SERVICE_NAMES.has(name)) return true;
      if (SYNC_SERVICE_NAMES.has(name)) return true;
      return false;
    });

  const hasDatabaseFailure = checks.some(check => check.name === 'database' && !check.ok);
  if (hasDatabaseFailure) {
    return { overall: 'degraded', degradedServices, checks };
  }

  if (degradedServices.length > 0) {
    return { overall: 'partially_healthy', degradedServices, checks };
  }

  return { overall: 'healthy', degradedServices: [], checks };
}

export function deriveRuntimeFallbackPolicy(checks: ReadinessCheck[]): RuntimeFallbackPolicy {
  const report = evaluateDependencyHealth(checks);
  const reasons: Record<string, string> = {};
  const enabledListeners: Array<'ethereum' | 'soroban' | 'solana'> = [];
  const disabledListeners: Array<'ethereum' | 'soroban' | 'solana'> = [];
  const databaseCheck = checks.find(candidate => candidate.name === 'database');
  if (databaseCheck?.ok === false) {
    reasons.database = databaseCheck.detail ?? 'unavailable';
    return {
      mode: 'degraded',
      enabledListeners: [],
      disabledListeners: ['ethereum', 'soroban', 'solana'],
      reasons,
    };
  }
  const listeners: Array<{ name: 'ethereum' | 'soroban' | 'solana'; checkName: string }> = [
    { name: 'ethereum', checkName: 'ethereum_rpc' },
    { name: 'soroban', checkName: 'soroban_rpc' },
    { name: 'solana', checkName: 'solana_rpc' },
  ];

  for (const listener of listeners) {
    const check = checks.find(candidate => candidate.name === listener.checkName);
    if (check?.ok === false) {
      disabledListeners.push(listener.name);
      reasons[listener.name] = check.detail ?? 'unavailable';
    } else {
      enabledListeners.push(listener.name);
    }
  }

  return {
    mode: report.overall,
    enabledListeners,
    disabledListeners,
    reasons,
  };
}
