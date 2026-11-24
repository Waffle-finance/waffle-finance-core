/**
 * Shared harness for cross-service integration tests (issues #1119, #1120,
 * #1121, #1123).
 *
 * Both services are started as isolated HTTP servers bound to ephemeral
 * loopback ports. They share a temporary SQLite database (the coordinator's
 * real schema and repository) but never call each other's repository in
 * process — the relayer talks to the coordinator over HTTP. Chain access is
 * replaced by deterministic simulators/fixtures, so no public RPC is used.
 *
 * Every resource is registered in a TestEnvironment; `cleanup()` is safe to
 * call more than once and is intended for `afterEach`/`finally` so a failing
 * assertion cannot leak a listener or a temp directory.
 */

import express from "express";
import type { Server } from "node:http";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../coordinator/src/persistence/db.js";
import {
  OrdersRepository,
  type AnnounceOrderInput,
  type OrderRow,
  type OrderStatus,
  type Chain,
} from "../coordinator/src/persistence/orders-repo.js";
import { EvmHtlcSim, SorobanHtlcSim, SolanaHtlcSim, type HtlcSim } from "./sim.js";
import { generateSecret } from "@wafflefinance/sdk/secrets";

export type { AnnounceOrderInput, OrderRow, OrderStatus, Chain };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Deterministic chain RPC fixture ──────────────────────────────────────────

export interface RpcControl {
  /** Artificial latency injected before every RPC response (ms). */
  delayMs: number;
  /** When true the RPC responds with a chain-specific outage error. */
  fail: boolean;
}

export interface ChainEvent {
  /** Chain the event was observed on (filled in by ChainFixture.deliver). */
  chain?: "ethereum" | "stellar" | "solana";
  /** Globally unique key used by the coordinator's durable idempotence ledger. */
  key: string;
  kind: "src_lock" | "dst_lock" | "secret_reveal" | "claim" | "refund";
  payload: Record<string, unknown>;
}

export class ChainFixture {
  readonly sim: HtlcSim;
  readonly control: RpcControl = { delayMs: 0, fail: false };
  readonly calls: string[] = [];
  private readonly queue: ChainEvent[] = [];
  /** Keys already delivered to listeners — recovery must replay missed ones once. */
  readonly delivered = new Set<string>();

  constructor(sim: HtlcSim) {
    this.sim = sim;
  }

  get name(): Chain {
    return this.sim.name === "evm" ? "ethereum" : this.sim.name === "soroban" ? "stellar" : "solana";
  }

  /** Simulated JSON-RPC round trip; faults are deterministic and per-chain. */
  async rpc<T>(method: string, fn: () => T): Promise<T> {
    this.calls.push(method);
    if (this.control.delayMs > 0) await sleep(this.control.delayMs);
    if (this.control.fail) throw new Error(`${this.name} RPC outage on ${method}`);
    return fn();
  }

  enqueue(event: ChainEvent): void {
    this.queue.push(event);
  }

  /** Outage: keep events queued so recovery can replay them. */
  async deliver(onEvent: (e: ChainEvent) => Promise<void>): Promise<number> {
    let delivered = 0;
    while (this.queue.length > 0) {
      // Peek first: an RPC outage leaves the event queued for recovery replay.
      const event = this.queue[0];
      await this.rpc(`getEvents:${event.kind}`, () => event);
      this.queue.shift();
      if (this.delivered.has(event.key)) continue;
      await onEvent({ ...event, chain: this.name });
      this.delivered.add(event.key);
      delivered++;
    }
    return delivered;
  }
}

export function defaultChains(): Record<"ethereum" | "stellar" | "solana", ChainFixture> {
  return {
    ethereum: new ChainFixture(new EvmHtlcSim()),
    stellar: new ChainFixture(new SorobanHtlcSim()),
    solana: new ChainFixture(new SolanaHtlcSim()),
  };
}

export function orderInput(
  direction: AnnounceOrderInput["direction"],
  hashlock: `0x${string}`,
  chains: Record<"ethereum" | "stellar" | "solana", ChainFixture>
): AnnounceOrderInput {
  const src = direction.startsWith("eth_") ? chains.ethereum : direction.startsWith("xlm_") ? chains.stellar : chains.solana;
  const dst = direction.endsWith("_eth") ? chains.ethereum : direction.endsWith("_xlm") ? chains.stellar : chains.solana;
  return {
    direction,
    hashlock,
    srcChain: src.name,
    srcAddress: `src-${src.name}`,
    srcAsset: "native",
    srcAmount: "1000000000000000",
    srcSafetyDeposit: "1000",
    dstChain: dst.name,
    dstAddress: `dst-${dst.name}`,
    dstAsset: "native",
    dstAmount: "990000000000000",
  };
}

// ── Persistent fund-moving ledger (relayer) ──────────────────────────────────

export interface SettlementRecord {
  key: string;
  orderId: string;
  kind: "src_lock" | "dst_lock" | "claim" | "refund" | "complete";
  chain: Chain;
}

/** Append-only JSON-lines ledger: survives a service restart. */
export class SettlementLedger {
  constructor(readonly path: string) {}

  append(record: SettlementRecord): boolean {
    const existing = this.all();
    if (existing.some((r) => r.key === record.key)) return false;
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    return true;
  }

  all(): SettlementRecord[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SettlementRecord);
  }

  count(kind?: SettlementRecord["kind"]): number {
    return this.all().filter((r) => kind === undefined || r.kind === kind).length;
  }

  move(from: ChainFixture, to: ChainFixture, orderId: string, kind: SettlementRecord["kind"]): boolean {
    return this.append({ key: `${orderId}:${kind}`, orderId, kind, chain: to.name });
  }
}

// ── Service processes ────────────────────────────────────────────────────────

export interface Service {
  readonly kind: "coordinator" | "relayer";
  readonly url: string;
  readonly db: Awaited<ReturnType<typeof openDatabase>>;
  readonly repo: OrdersRepository;
  readonly ledger?: SettlementLedger;
  readonly chains: Record<"ethereum" | "stellar" | "solana", ChainFixture>;
  close(): Promise<void>;
}

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test server");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

export interface TestEnvironment {
  readonly dir: string;
  readonly dbPath: string;
  readonly ledgerPath: string;
  readonly chains: Record<"ethereum" | "stellar" | "solana", ChainFixture>;
  coordinator?: Service;
  relayer?: Service;
  cleanup(): Promise<void>;
}

export function createEnvironment(): TestEnvironment {
  const dir = mkdtempSync(join(tmpdir(), "waffle-cross-service-"));
  const env: TestEnvironment = {
    dir,
    dbPath: join(dir, "coordinator.db"),
    ledgerPath: join(dir, "settlements.jsonl"),
    chains: defaultChains(),
    async cleanup() {
      await env.coordinator?.close();
      await env.relayer?.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return env;
}

export async function startCoordinator(env: TestEnvironment): Promise<Service> {
  const db = await openDatabase(`file:${env.dbPath}`);
  const repo = new OrdersRepository(db as never);
  const app = express();
  app.use(express.json());

  app.post("/api/orders", async (req, res) => {
    const input = req.body as AnnounceOrderInput;
    const existing = await repo.findByHashlock(input.hashlock);
    if (existing) {
      res.status(200).json({ ...existing, idempotent: true });
      return;
    }
    const order = await repo.announce(input);
    res.status(201).json(order);
  });

  app.get("/api/orders/:id", async (req, res) => {
    const order = await repo.findByPublicId(req.params.id);
    if (!order) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(order);
  });

  app.get("/api/orders/:id/events", async (req, res) => {
    res.json(await repo.findTransitionEvents(req.params.id));
  });

  /** Chain event ingestion. Durable event key makes replay idempotent. */
  app.post("/api/events", async (req, res) => {
    const body = req.body as {
      eventKey: string;
      chain: Chain;
      eventType: "OrderCreated" | "OrderClaimed" | "OrderRefunded";
      publicId: string;
      action: "src_lock" | "dst_lock" | "secret_reveal" | "complete" | "refund";
      args?: Record<string, unknown>;
    };
    const claimed = await repo.claimEvent({
      eventKey: body.eventKey,
      chain: body.chain,
      eventType: body.eventType,
      orderId: (await repo.findByPublicId(body.publicId))?.id ?? null,
    });
    if (!claimed) {
      res.json({ applied: false, duplicate: true });
      return;
    }
    const args = body.args ?? {};
    switch (body.action) {
      case "src_lock":
        await repo.recordSrcLock({
          publicId: body.publicId,
          orderId: String(args.orderId ?? "1"),
          txHash: String(args.txHash ?? "0xsrc"),
          blockNumber: Number(args.blockNumber ?? 1),
          timelock: Number(args.timelock ?? 600),
          actor: "relayer",
        });
        break;
      case "dst_lock":
        await repo.recordDstLock({
          publicId: body.publicId,
          orderId: String(args.orderId ?? "2"),
          txHash: String(args.txHash ?? "0xdst"),
          blockNumber: Number(args.blockNumber ?? 2),
          timelock: Number(args.timelock ?? 300),
          resolver: String(args.resolver ?? "resolver-1"),
          actor: "relayer",
        });
        break;
      case "secret_reveal":
        await repo.recordSecretRevealed({
          publicId: body.publicId,
          preimage: String(args.preimage ?? "0x00"),
          txHash: String(args.txHash ?? "0xreveal"),
          actor: "relayer",
        });
        break;
      case "complete":
        await repo.setStatus(body.publicId, "completed", "relayer");
        break;
      case "refund":
        await repo.setStatus(body.publicId, "refunded", "relayer");
        break;
    }
    res.json({ applied: true });
  });

  const { server, url } = await listen(app);
  const service: Service = {
    kind: "coordinator",
    url,
    db,
    repo,
    chains: env.chains,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
  env.coordinator = service;
  return service;
}

export async function startRelayer(env: TestEnvironment): Promise<Service> {
  const db = await openDatabase(`file:${env.dbPath}`);
  const repo = new OrdersRepository(db as never);
  const ledger = new SettlementLedger(env.ledgerPath);
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ status: "ok", service: "relayer" }));

  /** Relayer observes coordinator order state over the real HTTP boundary. */
  app.get("/api/orders/:id", async (req, res) => {
    const upstream = await fetch(`${env.coordinator!.url}/api/orders/${encodeURIComponent(req.params.id)}`);
    res.status(upstream.status).json(await upstream.json());
  });

  /**
   * Deliver a chain event: the relayer reads chain truth from the fixture,
   * records its fund-moving transaction, then asks the coordinator to apply
   * the state transition over HTTP. Replays are deduplicated by event key.
   */
  app.post("/api/events", async (req, res) => {
    const body = req.body as ChainEvent & { publicId: string; chain?: keyof typeof env.chains };
    const chain = env.chains[body.chain ?? "ethereum"];
    try {
      await chain.rpc("getTransactionReceipt", () => true);
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const recorded = ledger.append({
      key: body.key,
      orderId: body.publicId,
      kind: body.kind === "claim" ? "claim" : body.kind === "refund" ? "refund" : body.kind,
      chain: chain.name,
    });
    // The coordinator's idempotence ledger uses its own chain vocabulary
    // ("soroban" for Stellar); map the service-facing chain name accordingly.
    const ledgerChain = chain.name === "stellar" ? "soroban" : chain.name;
    const upstream = await fetch(`${env.coordinator!.url}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventKey: body.key,
        chain: ledgerChain,
        eventType:
          body.kind === "claim" ? "OrderClaimed" : body.kind === "refund" ? "OrderRefunded" : "OrderCreated",
        publicId: body.publicId,
        action: body.kind === "claim" ? "complete" : body.kind === "refund" ? "refund" : body.kind,
        args: body.payload,
      }),
    });
    res.status(upstream.status).json({ recorded, result: await upstream.json() });
  });

  app.get("/api/settlements", (_req, res) => res.json(ledger.all()));

  const { server, url } = await listen(app);
  const service: Service = {
    kind: "relayer",
    url,
    db,
    repo,
    ledger,
    chains: env.chains,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
  env.relayer = service;
  return service;
}

/** Restart a service in place, preserving the same database and ledger. */
export async function restart(env: TestEnvironment, kind: "coordinator" | "relayer"): Promise<Service> {
  await (kind === "coordinator" ? env.coordinator : env.relayer)!.close();
  return kind === "coordinator" ? startCoordinator(env) : startRelayer(env);
}

// ── Lifecycle driver shared by the tests ────────────────────────────────────

export interface LifecycleOptions {
  direction?: AnnounceOrderInput["direction"];
  /** Restart the given service immediately after this boundary. */
  restartAfter?: "src_lock" | "dst_lock" | "secret_reveal";
  /** Which service to restart (defaults to the relayer). */
  restartService?: "coordinator" | "relayer";
  onBoundary?: (boundary: "src_lock" | "dst_lock" | "secret_reveal", env: TestEnvironment) => Promise<void>;
}

export interface LifecycleResult {
  publicId: string;
  order: OrderRow;
  transitions: string[];
  secret: ReturnType<typeof generateSecret>;
}

/** Announce an order and deliver the full successful settlement lifecycle. */
export async function runSettlement(env: TestEnvironment, opts: LifecycleOptions = {}): Promise<LifecycleResult> {
  const direction = opts.direction ?? "eth_to_xlm";
  const secret = generateSecret();
  const announceRes = await fetch(`${env.coordinator!.url}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(orderInput(direction, secret.sha256, env.chains)),
  });
  const order = (await announceRes.json()) as OrderRow;

  const srcChain = direction.startsWith("eth_") ? env.chains.ethereum : direction.startsWith("xlm_") ? env.chains.stellar : env.chains.solana;
  const dstChain = direction.endsWith("_eth") ? env.chains.ethereum : direction.endsWith("_xlm") ? env.chains.stellar : env.chains.solana;

  const boundaries = [
    {
      name: "src_lock" as const,
      chain: srcChain,
      event: {
        key: `${order.publicId}:src_lock`,
        kind: "src_lock" as const,
        payload: { orderId: "1", txHash: "0xsrc", blockNumber: 1, timelock: 1200 },
      },
    },
    {
      name: "dst_lock" as const,
      chain: dstChain,
      event: {
        key: `${order.publicId}:dst_lock`,
        kind: "dst_lock" as const,
        payload: { orderId: "2", txHash: "0xdst", blockNumber: 2, timelock: 600 },
      },
    },
    {
      name: "secret_reveal" as const,
      chain: dstChain,
      event: {
        key: `${order.publicId}:secret_reveal`,
        kind: "secret_reveal" as const,
        payload: { preimage: secret.preimage, txHash: "0xreveal" },
      },
    },
  ];

  // Upstream chain truth: both HTLC legs can be claimed with the same preimage.
  srcChain.sim.createOrder({ hashlock: secret.sha256, timelockSeconds: 1200 });
  dstChain.sim.createOrder({ hashlock: secret.sha256, timelockSeconds: 600 });

  for (const boundary of boundaries) {
    boundary.chain.enqueue(boundary.event);
    await boundary.chain.deliver(async (event) => {
      const res = await fetch(`${env.relayer!.url}/api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...event, publicId: order.publicId }),
      });
      if (!res.ok) throw new Error(`relayer rejected ${boundary.name}: ${await res.text()}`);
    });
    if (opts.restartAfter === boundary.name) await restart(env, opts.restartService ?? "relayer");
    if (opts.onBoundary) await opts.onBoundary(boundary.name, env);
  }

  // Final claim events move both legs to Claimed through chain truth.
  for (const [chain, id] of [
    [srcChain, 1n],
    [dstChain, 1n],
  ] as const) {
    const event: ChainEvent = { key: `${order.publicId}:claim:${chain.name}`, kind: "claim", payload: {} };
    chain.enqueue(event);
    await chain.deliver(async (e) => {
      await fetch(`${env.relayer!.url}/api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...e, publicId: order.publicId }),
      });
    });
  }

  const finalRes = await fetch(`${env.coordinator!.url}/api/orders/${order.publicId}`);
  const transitions = (await (
    await fetch(`${env.coordinator!.url}/api/orders/${order.publicId}/events`)
  ).json()) as Array<{ eventType: string }>;
  return {
    publicId: order.publicId,
    order: (await finalRes.json()) as OrderRow,
    transitions: transitions.map((t) => t.eventType),
    secret,
  };
}
