# Relayer load testing: concurrent order processing

The load harness in `test/load/` runs the real `JobManagerService` against a
mock RPC. The job manager is the relayer's priority queue, concurrency
limiter and retry queue. The workload is a deterministic mix of lock, claim
and refund actions.

```bash
pnpm --filter @wafflefinance/relayer test:load                 # assertions only
LOAD_REPORT=1 pnpm --filter @wafflefinance/relayer test:load   # also print tables
```

## What the harness models

| Concern | How it is modelled |
|---|---|
| **RPC quota** | `MockRpc` allows `rpcQuota` concurrent requests. Any request beyond that fails right away with a 429. |
| **Latency** | Each method has a base latency plus seeded jitter: estimateGas 40 ms, eth_call 30 ms, getBlock 25 ms, sendRawTransaction 60 ms, receipt 120 ms, plus up to 20 ms of jitter. |
| **Signing-account nonces** | A `KeyedMutex`-guarded allocator hands out nonces for the signer. A retried job reuses its nonce. The mock rejects any nonce it has already accepted. |
| **Retry queue** | A 429 is retried inside the action up to 3 times, with backoff starting at 25 ms. If those retries run out, the job fails and the job manager re-enqueues it up to 2 more times. |
| **Order lifecycle** | `lock` (P0) runs estimateGas, send, receipt. It is followed by either `claim` (P0: eth_call, send, receipt) or, for 30% of orders, `refund` (P1: eth_call, getBlock, send, receipt). |
| **Producers** | Orders arrive on a fixed schedule. A producer that gets `QueueFullError` waits on `whenCapacityAvailable()` before resubmitting. |

The harness needs no private keys and no network. Time comes from fake
timers and randomness from a seeded PRNG, so the same config always produces
the same numbers. A test asserts this. Heap growth is the only measurement
that varies between runs, and it is reported for information only.

## Measurements

These are virtual-time results from `LOAD_REPORT=1`, seed 1088.

### Concurrency sweep: 300 orders, one arriving every 2 ms, RPC quota 16

| concurrency | orders/s | p95 completion | RPC calls/order | 429s | failed orders |
|---:|---:|---:|---:|---:|---:|
| 1  | 2.00  | 145.9 s | 6.32  | 0    | 0   |
| 2  | 3.39  | 83.7 s  | 6.32  | 0    | 0   |
| 4  | 6.77  | 41.6 s  | 6.32  | 0    | 0   |
| 8  | 13.59 | 20.8 s  | 6.32  | 0    | 0   |
| 16 | 26.93 | 10.3 s  | 6.32  | 0    | 0   |
| 32 | 28.13 | 6.7 s   | 11.54 | 2070 | 100 |

Throughput grows almost linearly with concurrency up to the RPC quota. Past
the quota, the extra slots buy about 4% more throughput, but they also:

- nearly double the RPC calls per order (6.32 → 11.54), which burns provider
  quota;
- make one order in three fail permanently, because the retry budget runs out
  while every slot competes for the same quota.

### Burst of 600 orders at once, concurrency 8

| maxQueueDepth | peak queue | peak blocked producers | orders/s | p95 completion |
|---|---:|---:|---:|---:|
| 25 | 25 | 575 | 15.61 | 36.7 s |
| effectively unbounded | 600 | 0 | 13.60 | 42.1 s |

With the cap, the backlog waits in the producers as parked promises instead
of growing the in-memory queue. Throughput does not drop. The capped run is
actually slightly faster: a claim can join the queue soon after its lock,
instead of waiting behind every lock in the burst.

## Concurrency limits and tuning

1. **Keep the job manager's `global` limit (and the `live_settlement` +
   `recovery` caps) at or below the RPC provider's concurrent-request
   quota.** In this harness, each running job holds at most one RPC request
   at a time, so running jobs ≈ RPC requests in flight. Going over the quota
   increases RPC cost and order failures, and adds almost no throughput.
2. **`maxQueueDepth` (default 1000) bounds the pending queue.** When the
   queue is full, `submitJob()` throws `QueueFullError` and
   `relayer_job_rejected_total` is incremented. Producers should wait on
   `whenCapacityAvailable()`, which wakes one waiting producer for each free
   slot. Retries of jobs that were already admitted are always re-enqueued,
   so the queue can exceed the cap by at most `global` entries.
3. **`maxRetainedJobs` (default 10,000) bounds the job registry.** Completed,
   failed and cancelled records are pruned oldest first, so memory does not
   grow for the life of the process.
4. **A freed slot is handed to the next job immediately** instead of waiting
   for the next scheduler tick (`tickIntervalMs`, default 50 ms). This removes
   up to one tick of idle time per job under load.
5. **Nonces.** Allocate under a per-signer mutex, and reuse the nonce when a
   job is retried. With that pattern, no run in the harness reused a nonce or
   left a gap while concurrency stayed within the quota.

### Changes made from these results

- `JobManagerService`: added `maxQueueDepth` / `QueueFullError` /
  `whenCapacityAvailable()`, `maxRetainedJobs`, all-or-nothing
  `submitJobs()`, dispatch when a slot is released, and the
  `relayer_job_rejected_total` metric.
- Fixed the job-manager modules' logger import path
  (`../logger.js` → `../../logger.js`) and an invalid optional-chaining
  assignment in `PriorityQueue.clear()`. Before these fixes the job-manager
  modules failed to load.
