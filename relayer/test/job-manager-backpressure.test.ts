import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
});

import { describe, it, expect, afterEach } from 'vitest';
import {
  JobManagerService,
  QueueFullError,
  type Job,
} from '../src/services/job-manager/index.js';

const job = (id: string, overrides: Partial<Job> = {}): Job => ({
  id,
  type: 'live_settlement',
  priority: 0,
  status: 'pending',
  payload: {},
  createdAt: Date.now(),
  retryCount: 0,
  maxRetries: 0,
  ...overrides,
});

let jm: JobManagerService | undefined;
afterEach(() => {
  jm?.stop();
  jm = undefined;
  vi.useRealTimers();
});

describe('JobManagerService backpressure', () => {
  it('rejects submissions beyond maxQueueDepth with QueueFullError', async () => {
    jm = new JobManagerService({ maxQueueDepth: 2 });
    await jm.submitJob(job('a'));
    await jm.submitJob(job('b'));
    const err = await jm.submitJob(job('c')).catch((e) => e);
    expect(err).toBeInstanceOf(QueueFullError);
    expect(err).toMatchObject({ queueDepth: 2, maxQueueDepth: 2, code: 'JOB_QUEUE_FULL' });
    expect(jm.getJob('c')).toBeUndefined();
    expect(jm.getRejectedCount()).toBe(1);
  });

  it('admits a batch all-or-nothing', async () => {
    jm = new JobManagerService({ maxQueueDepth: 3 });
    await jm.submitJob(job('a'));
    await expect(jm.submitJobs([job('b'), job('c'), job('d')])).rejects.toBeInstanceOf(QueueFullError);
    expect(jm.getStats().queueDepth).toBe(1);
    await expect(jm.submitJobs([job('b'), job('c')], 'batch-1')).resolves.toEqual(['b', 'c']);
    expect(jm.getJob('b')?.batchId).toBe('batch-1');
  });

  it('wakes waiting producers one per freed slot as the queue drains', async () => {
    vi.useFakeTimers();
    jm = new JobManagerService({ maxQueueDepth: 2, tickIntervalMs: 10, limits: { global: 1 } });
    const gates: Array<() => void> = [];
    jm.registerExecutor('live_settlement', () => new Promise<void>((r) => gates.push(r)));
    await jm.submitJob(job('a'));
    await jm.submitJob(job('b'));

    let woken = 0;
    const waiters = [jm.whenCapacityAvailable(), jm.whenCapacityAvailable()];
    waiters.forEach((w) => void w.then(() => woken++));

    jm.start();
    await vi.advanceTimersByTimeAsync(10); // 'a' dispatched → one slot free
    expect(woken).toBe(1);

    gates.shift()!(); // 'a' finishes → 'b' dispatched immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(woken).toBe(2);
  });

  it('resolves whenCapacityAvailable immediately when there is room', async () => {
    jm = new JobManagerService({ maxQueueDepth: 5 });
    await expect(jm.whenCapacityAvailable()).resolves.toBeUndefined();
  });

  it('dispatches the next job as soon as a slot frees, without waiting for a tick', async () => {
    vi.useFakeTimers();
    jm = new JobManagerService({ tickIntervalMs: 1_000, limits: { global: 1 } });
    const started: string[] = [];
    const gates: Array<() => void> = [];
    jm.registerExecutor('live_settlement', (j) => {
      started.push(j.id);
      return new Promise<void>((r) => gates.push(r));
    });
    await jm.submitJob(job('a'));
    await jm.submitJob(job('b'));
    jm.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toEqual(['a']);
    gates.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(['a', 'b']);
  });

  it('prunes the oldest terminal records beyond maxRetainedJobs', async () => {
    vi.useFakeTimers();
    jm = new JobManagerService({ maxRetainedJobs: 2, tickIntervalMs: 5 });
    jm.registerExecutor('live_settlement', async () => undefined);
    await jm.submitJobs([job('a'), job('b'), job('c')]);
    jm.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(jm.getTotalCount()).toBe(2);
    expect(jm.getJob('a')).toBeUndefined();
    expect(jm.getJob('c')?.status).toBe('completed');
  });
});
