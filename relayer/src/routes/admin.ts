/**
 * @fileoverview Relayer administration routes.
 */

import { Router, type Request, type Response } from 'express';
import { ethers } from 'ethers';
import { getLogger } from '../logger.js';
import { requireAdminAuth } from '../middleware/admin-auth.js';
import {
  getEscrowFactoryAddress,
  getEscrowFactoryABI,
  type NetworkMode,
} from '../config/networks.js';
import { globalSettlementFailureStore } from '../services/settlement-failure-store.js';

const logger = getLogger().child({ component: 'admin-router' });

export interface AdminRouterOptions {
  relayerConfig: Record<string, unknown>;
  defaultNetworkMode: NetworkMode;
}

export function adminRouter(options: AdminRouterOptions): Router {
  const router = Router();
  const { relayerConfig: RELAYER_CONFIG, defaultNetworkMode: DEFAULT_NETWORK_MODE } = options;

  router.post('/api/admin/authorize-relayer', requireAdminAuth(), async (req: Request, res: Response) => {
    try {
      const adminPk = process.env.RELAYER_ADMIN_PRIVATE_KEY;
      if (!adminPk) return res.status(500).json({ success: false, error: 'RELAYER_ADMIN_PRIVATE_KEY not configured' });
      const relayerPk = process.env.RELAYER_PRIVATE_KEY;
      if (!relayerPk) return res.status(503).json({ success: false, error: 'RELAYER_PRIVATE_KEY not configured' });

      const ethConfig = RELAYER_CONFIG.ethereum as Record<string, unknown>;
      const provider = new ethers.JsonRpcProvider(ethConfig.rpcUrl as string);
      const adminWallet = new ethers.Wallet(adminPk, provider);
      const relayerAddress = new ethers.Wallet(relayerPk).address;
      const contract = new ethers.Contract(getEscrowFactoryAddress(DEFAULT_NETWORK_MODE, DEFAULT_NETWORK_MODE), getEscrowFactoryABI(DEFAULT_NETWORK_MODE === 'mainnet'), adminWallet) as ethers.Contract & { authorizeResolver: (addr: string) => Promise<{ hash: string; wait: () => Promise<unknown> }> };
      const tx = await contract.authorizeResolver(relayerAddress);
      logger.info({ relayerAddress, txHash: tx.hash }, 'Relayer authorization tx sent');
      await tx.wait();
      logger.info({ relayerAddress }, 'Relayer authorized as resolver');
      res.json({ success: true, relayerAddress, txHash: tx.hash, message: 'Relayer authorized as resolver' });
    } catch (err: unknown) {
      logger.error({ err }, 'Failed to authorize relayer');
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/api/admin/relayer-status', requireAdminAuth(), async (_req: Request, res: Response) => {
    try {
      const relayerPk = process.env.RELAYER_PRIVATE_KEY;
      if (!relayerPk) return res.status(503).json({ success: false, error: 'RELAYER_PRIVATE_KEY not configured' });
      const relayerAddress = new ethers.Wallet(relayerPk).address;
      const ethConfig = RELAYER_CONFIG.ethereum as Record<string, unknown>;
      const provider = new ethers.JsonRpcProvider(ethConfig.rpcUrl as string);
      const contract = new ethers.Contract(getEscrowFactoryAddress(DEFAULT_NETWORK_MODE, DEFAULT_NETWORK_MODE), getEscrowFactoryABI(DEFAULT_NETWORK_MODE === 'mainnet'), provider) as ethers.Contract & { authorizedResolvers: (addr: string) => Promise<boolean> };
      const isAuthorized = await contract.authorizedResolvers(relayerAddress);
      res.json({ success: true, relayerAddress, isAuthorized, status: isAuthorized ? 'Authorized' : 'Not Authorized' });
    } catch (err: unknown) {
      logger.error({ err }, 'Failed to check relayer status');
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/api/admin/resolvers', requireAdminAuth(), async (_req: Request, res: Response) => {
    try {
      const relayerPk = process.env.RELAYER_PRIVATE_KEY;
      if (!relayerPk) return res.status(503).json({ success: false, error: 'RELAYER_PRIVATE_KEY not configured' });
      const relayerAddress = new ethers.Wallet(relayerPk).address;
      const allowlist = (RELAYER_CONFIG.resolverAllowlist as string[]) ?? [];
      const addresses = Array.from(new Set([relayerAddress, ...allowlist])).filter(Boolean);
      const ethConfig = RELAYER_CONFIG.ethereum as Record<string, unknown>;
      const provider = new ethers.JsonRpcProvider(ethConfig.rpcUrl as string);
      const contract = new ethers.Contract(getEscrowFactoryAddress(DEFAULT_NETWORK_MODE, DEFAULT_NETWORK_MODE), getEscrowFactoryABI(DEFAULT_NETWORK_MODE === 'mainnet'), provider) as ethers.Contract & { authorizedResolvers: (addr: string) => Promise<boolean> };
      const results = await Promise.all(addresses.map(async (address) => ({ address, isAuthorized: await contract.authorizedResolvers(address) })));
      res.json({ success: true, resolvers: results });
    } catch (err: unknown) {
      logger.error({ err }, 'Failed to list resolvers');
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/api/admin/settlement-failures', requireAdminAuth(), (req: Request, res: Response) => {
    try {
      const statusFilter = typeof req.query.status === 'string' ? req.query.status : undefined;
      const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
      const all = globalSettlementFailureStore.all()
        .filter((r) => !statusFilter || r.recoveryStatus === statusFilter)
        .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
        .slice(0, limit);
      res.json({ summary: globalSettlementFailureStore.summary(), total: globalSettlementFailureStore.size(), filtered: all.length, records: all.map((r) => ({ orderId: r.orderId, direction: r.direction, recoveryStatus: r.recoveryStatus, failureCount: r.failureCount, recoveryAttempts: r.recoveryAttempts, firstFailedAt: new Date(r.firstFailedAt).toISOString(), lastUpdatedAt: new Date(r.lastUpdatedAt).toISOString(), terminalReason: r.terminalReason, recoveredTxHash: r.recoveredTxHash, recentEvents: r.events.slice(-3).map((e) => ({ at: e.at, category: e.category, recoverability: e.recoverability, chain: e.chain, attempt: e.attempt, errorMessage: e.errorMessage, recoveryAction: e.recoveryAction })) })) });
    } catch (err: unknown) {
      logger.error({ err }, '/api/admin/settlement-failures failed');
      res.status(500).json({ error: 'Failed to retrieve settlement failures' });
    }
  });

  router.get('/api/admin/settlement-failures/:orderId', requireAdminAuth(), (req: Request, res: Response) => {
    try {
      const record = globalSettlementFailureStore.get(req.params.orderId);
      if (!record) return res.status(404).json({ error: 'No failure record found', orderId: req.params.orderId });
      res.json({ record });
    } catch (err: unknown) {
      logger.error({ err }, '/api/admin/settlement-failures/:orderId failed');
      res.status(500).json({ error: 'Failed to retrieve failure record' });
    }
  });

  return router;
}
