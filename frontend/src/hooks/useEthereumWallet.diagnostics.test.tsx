/**
 * useEthereumWallet diagnostics tests — wagmi v2 (issue #470)
 *
 * Verifies the same public error codes as before:
 *   metamask_unavailable  — no injected connector registered
 *   network_mismatch      — connected to wrong chain
 *   wallet_locked         — connector error code -32002
 *   metamask_connect_failed — user rejected (4001) or generic failure
 *
 * Strategy: mock wagmi v2 hooks at the module boundary so we never need a
 * real WagmiProvider in the test tree.  Each test controls the values
 * returned by useAccount / useConnect / useSwitchChain / useChainId /
 * useConnectors and observes the transformed state exposed by useEthereumWallet.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useEthereumWallet } from './useEthereumWallet';

// ── wagmi v2 module mock ──────────────────────────────────────────────────────
//
// We replace every wagmi hook used by useEthereumWallet with vi.fn() factories
// that return controllable state objects.  Tests mutate these via
// `mockReturnValue` inside each `it` block.

const mockUseAccount = vi.fn();
const mockUseConnect = vi.fn();
const mockUseDisconnect = vi.fn();
const mockUseSwitchChain = vi.fn();
const mockUseChainId = vi.fn();
const mockUseConnectors = vi.fn();

vi.mock('wagmi', () => ({
  useAccount: () => mockUseAccount(),
  useConnect: () => mockUseConnect(),
  useDisconnect: () => mockUseDisconnect(),
  useSwitchChain: () => mockUseSwitchChain(),
  useChainId: () => mockUseChainId(),
  useConnectors: () => mockUseConnectors(),
}));

// wagmi/chains is used only for chain IDs — mock the numeric constants.
vi.mock('wagmi/chains', () => ({
  mainnet: { id: 1 },
  sepolia: { id: 11155111 },
}));

// ── Default wagmi return values ───────────────────────────────────────────────

function makeDefaults() {
  return {
    account: {
      address: undefined as string | undefined,
      isConnected: false,
      isConnecting: false,
      isReconnecting: false,
      connector: undefined,
    },
    connect: {
      connectAsync: vi.fn(),
      isPending: false,
      error: null as Error | null,
    },
    disconnect: {
      disconnect: vi.fn(),
    },
    switchChain: {
      switchChainAsync: vi.fn(),
      isPending: false,
      error: null as Error | null,
    },
    chainId: 11155111, // Sepolia by default
    connectors: [] as any[],
  };
}

let defaults = makeDefaults();

function applyDefaults() {
  mockUseAccount.mockReturnValue(defaults.account);
  mockUseConnect.mockReturnValue(defaults.connect);
  mockUseDisconnect.mockReturnValue(defaults.disconnect);
  mockUseSwitchChain.mockReturnValue(defaults.switchChain);
  mockUseChainId.mockReturnValue(defaults.chainId);
  mockUseConnectors.mockReturnValue(defaults.connectors);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('useEthereumWallet — diagnostics (issue #470 / wagmi v2)', () => {
  beforeEach(() => {
    defaults = makeDefaults();
    applyDefaults();
    vi.stubEnv('VITE_NETWORK_MODE', 'testnet');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  // ── metamask_unavailable ────────────────────────────────────────────────

  it('sets errorCode=metamask_unavailable when no injected connector is registered', async () => {
    // connectors is empty → isInstalled = false
    mockUseConnectors.mockReturnValue([]);

    // connect() called while not installed
    mockUseConnect.mockReturnValue({
      connectAsync: vi.fn(),
      isPending: false,
      error: null,
    });

    const { result } = renderHook(() => useEthereumWallet());

    // Trigger connect — the hook should detect missing provider synchronously.
    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.errorCode).toBe('metamask_unavailable');
    expect(result.current.hint).toMatch(/install/i);
    expect(result.current.isInstalled).toBe(false);
  });

  // ── network_mismatch ────────────────────────────────────────────────────

  it('sets errorCode=network_mismatch when connected to Ethereum mainnet (chain 1) in testnet mode', async () => {
    // Simulate: connected, chainId = 1 (mainnet), but VITE_NETWORK_MODE=testnet
    mockUseAccount.mockReturnValue({
      address: '0xUserAddress',
      isConnected: true,
      isConnecting: false,
      isReconnecting: false,
      connector: { type: 'injected' },
    });
    mockUseChainId.mockReturnValue(1); // mainnet
    mockUseConnectors.mockReturnValue([{ type: 'injected', id: 'metaMask' }]);

    const { result } = renderHook(() => useEthereumWallet());

    // The mismatch effect fires on mount once isConnected=true and chainId=1
    await waitFor(() =>
      expect(result.current.errorCode).toBe('network_mismatch'),
    );
    expect(result.current.error).toMatch(/wrong network/i);
    expect(result.current.hint).toMatch(/sepolia/i);
  });

  // ── wallet_locked ───────────────────────────────────────────────────────

  it('sets errorCode=wallet_locked when wagmi surfaces error code -32002', async () => {
    const lockedError = Object.assign(
      new Error('MetaMask is locked or the request is already pending'),
      { code: -32002 },
    );

    mockUseConnectors.mockReturnValue([{ type: 'injected', id: 'metaMask' }]);

    // First render: no error yet
    mockUseConnect.mockReturnValue({
      connectAsync: vi.fn(),
      isPending: false,
      error: null,
    });

    const { result, rerender } = renderHook(() => useEthereumWallet());

    // Now surface the locked error through the connect hook
    mockUseConnect.mockReturnValue({
      connectAsync: vi.fn(),
      isPending: false,
      error: lockedError,
    });

    rerender();

    await waitFor(() => expect(result.current.errorCode).toBe('wallet_locked'));
    expect(result.current.error).toMatch(/locked/i);
    expect(result.current.hint).toMatch(/unlock/i);
  });

  // ── metamask_connect_failed (user rejected) ─────────────────────────────

  it('sets errorCode=metamask_connect_failed when wagmi surfaces error code 4001', async () => {
    const rejectError = Object.assign(new Error('User rejected the request.'), {
      code: 4001,
    });

    mockUseConnectors.mockReturnValue([{ type: 'injected', id: 'metaMask' }]);
    mockUseConnect.mockReturnValue({
      connectAsync: vi.fn(),
      isPending: false,
      error: null,
    });

    const { result, rerender } = renderHook(() => useEthereumWallet());

    mockUseConnect.mockReturnValue({
      connectAsync: vi.fn(),
      isPending: false,
      error: rejectError,
    });

    rerender();

    await waitFor(() =>
      expect(result.current.errorCode).toBe('metamask_connect_failed'),
    );
    expect(result.current.hint).toMatch(/rejected/i);
  });

  // ── successful connection ───────────────────────────────────────────────

  it('reports isConnected=true and clears errors on successful Sepolia connection', async () => {
    mockUseAccount.mockReturnValue({
      address: '0xUserAddress',
      isConnected: true,
      isConnecting: false,
      isReconnecting: false,
      connector: { type: 'injected' },
    });
    mockUseChainId.mockReturnValue(11155111); // Sepolia — correct for testnet mode
    mockUseConnectors.mockReturnValue([{ type: 'injected', id: 'metaMask' }]);
    mockUseConnect.mockReturnValue({
      connectAsync: vi.fn(),
      isPending: false,
      error: null,
    });

    const { result } = renderHook(() => useEthereumWallet());

    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(result.current.errorCode).toBeNull();
    expect(result.current.address).toBe('0xUserAddress');
    expect(result.current.phase).toBe('connected');
    // chainId should be the hex representation
    expect(result.current.chainId).toBe('0xaa36a7');
  });

  // ── isInstalled reflects connectors ────────────────────────────────────

  it('reports isInstalled=true when an injected connector is registered', () => {
    mockUseConnectors.mockReturnValue([{ type: 'injected', id: 'metaMask' }]);

    const { result } = renderHook(() => useEthereumWallet());
    expect(result.current.isInstalled).toBe(true);
  });

  it('reports isInstalled=false when only non-injected connectors exist', () => {
    mockUseConnectors.mockReturnValue([{ type: 'walletConnect', id: 'wc' }]);

    const { result } = renderHook(() => useEthereumWallet());
    expect(result.current.isInstalled).toBe(false);
  });

  // ── disconnect ──────────────────────────────────────────────────────────

  it('calls wagmi disconnect when disconnect() is invoked', async () => {
    const wagmiDisconnect = vi.fn();
    mockUseDisconnect.mockReturnValue({ disconnect: wagmiDisconnect });
    mockUseConnectors.mockReturnValue([{ type: 'injected', id: 'metaMask' }]);

    const { result } = renderHook(() => useEthereumWallet());

    act(() => result.current.disconnect());

    expect(wagmiDisconnect).toHaveBeenCalledOnce();
  });

  // ── switchToExpectedChain ───────────────────────────────────────────────

  it('calls wagmi switchChain with sepolia chainId for testnet mode', () => {
    const switchChainFn = vi.fn();
    mockUseSwitchChain.mockReturnValue({ switchChainAsync: switchChainFn, isPending: false, error: null });
    mockUseConnectors.mockReturnValue([{ type: 'injected', id: 'metaMask' }]);

    const { result } = renderHook(() => useEthereumWallet());

    act(() => result.current.switchToExpectedChain('testnet'));

    expect(switchChainFn).toHaveBeenCalledWith({ chainId: 11155111 });
  });

  it('calls wagmi switchChain with mainnet chainId for mainnet mode', () => {
    const switchChainFn = vi.fn();
    mockUseSwitchChain.mockReturnValue({ switchChainAsync: switchChainFn, isPending: false, error: null });
    mockUseConnectors.mockReturnValue([{ type: 'injected', id: 'metaMask' }]);

    const { result } = renderHook(() => useEthereumWallet());

    act(() => result.current.switchToExpectedChain('mainnet'));

    expect(switchChainFn).toHaveBeenCalledWith({ chainId: 1 });
  });
});
