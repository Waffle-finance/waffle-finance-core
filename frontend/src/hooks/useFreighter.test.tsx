import { renderHook, waitFor } from '@testing-library/react';
import { vi } from 'vitest';

vi.mock('@stellar/freighter-api', () => ({
  default: {
    isConnected: vi.fn(async () => true),
    getAddress: vi.fn(async () => ({ address: 'GTESTADDR' })),
    getNetwork: vi.fn(async () => ({
      network: 'TESTNET',
      networkPassphrase: 'Test SDF Network ; September 2015',
    })),
    setAllowed: vi.fn(async () => true),
    signTransaction: vi.fn(),
  },
}));

import { useFreighter } from './useFreighter';

describe('useFreighter', () => {
  it('exposes connected address and network state on mount', async () => {
    const { result } = renderHook(() => useFreighter());

    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(result.current.address).toBe('GTESTADDR');
    expect(result.current.network).toBe('TESTNET');
    expect(result.current.networkPassphrase).toContain('Test SDF Network');
  });
});
