/**
 * Poll loop with two speeds:
 * - **Attentive** (visitor on site or order in flight): re-check every `activeIntervalMs`
 * - **Deep idle** (no visitors, no orders): re-check every `idleIntervalMs`
 *
 * `tick()` (RPC) runs only when `isActive()` is true. Attentive mode does
 * not hit the chain — it just keeps the loop ready so a new order is picked
 * up within one active window.
 *
 * When `tick()` throws, the poll loop applies exponential backoff up to
 * `maxBackoffMs` so transient RPC failures don't hammer the endpoint.
 */

export interface AdaptivePollOptions {
  label: string;
  /** Re-check cadence while attentive or while `isActive()`. */
  activeIntervalMs: number;
  /** Re-check cadence when nobody is on the site and `isActive()` is false. */
  idleIntervalMs?: number;
  /** When true, `tick()` may run (usually: open bridge orders exist). */
  isActive: () => boolean;
  /**
   * When true, use `activeIntervalMs` even if `isActive()` is false.
   * Typically wired to `hasRecentVisitor()`.
   */
  isAttentive?: () => boolean;
  tick: () => Promise<void>;
  /**
   * Maximum backoff between retries after a failed tick. Defaults to 30s.
   * Backoff resets on a successful tick.
   */
  maxBackoffMs?: number;
}

export interface AdaptivePollHandle {
  stop(): void;
  /** Run a check immediately (e.g. visitor ping or new order). */
  wake(): void;
}

export function startAdaptivePoll(options: AdaptivePollOptions): AdaptivePollHandle {
  const {
    label,
    activeIntervalMs,
    idleIntervalMs = 120_000,
    isActive,
    isAttentive = () => false,
    tick,
    maxBackoffMs = 30_000,
  } = options;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let consecutiveFailures = 0;

  const calculateBackoff = (): number => {
    if (consecutiveFailures === 0) return 0;
    const delay = Math.min(maxBackoffMs, 1_000 * Math.pow(2, consecutiveFailures - 1));
    const jitter = 0.2 * delay * (Math.random() - 0.5);
    return Math.round(delay + jitter);
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => { void run(); }, delayMs);
  };

  const run = async () => {
    if (stopped || running) return;
    running = true;
    const active = isActive();
    const attentive = isAttentive();
    try {
      if (active) {
        await tick();
        consecutiveFailures = 0;
      }
    } catch (err: any) {
      consecutiveFailures++;
      console.warn(
        `[${label}] poll tick failed (${consecutiveFailures} consecutive):`,
        err?.shortMessage ?? err?.message ?? err,
      );
    } finally {
      running = false;
      if (consecutiveFailures > 0) {
        const backoff = calculateBackoff();
        console.warn(`[${label}] backing off ${backoff}ms after ${consecutiveFailures} failure(s)`);
        schedule(backoff);
      } else {
        schedule(active || attentive ? activeIntervalMs : idleIntervalMs);
      }
    }
  };

  schedule(0);
  console.log(
    `[${label}] adaptive poll — attentive ${activeIntervalMs / 1000}s / deep idle ${idleIntervalMs / 1000}s, RPC only when active`,
  );

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    wake() {
      if (stopped || running) return;
      if (timer) clearTimeout(timer);
      consecutiveFailures = 0;
      schedule(0);
    },
  };
}
