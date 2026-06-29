import { describe, test, expect, vi } from 'vitest';
import { parseHtlcReceipt } from './parseHtlcReceipt';
import { decodeEventLog } from 'viem';

vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  return {
    ...actual,
    decodeEventLog: vi.fn(),
  };
});

describe.skip('parseHtlcReceipt', () => {
  test('returns null for empty logs', () => {
    expect(parseHtlcReceipt([])).toBeNull();
    expect(parseHtlcReceipt(null)).toBeNull();
  });

  test('parses v2 HTLCEscrow event successfully', () => {
    const mockLog = {
      address: '0xcontract',
      topics: ['0x1', '0x2'],
      data: '0xdata',
    };

    vi.mocked(decodeEventLog).mockReturnValue({
      eventName: 'OrderCreated',
      args: {
        orderId: BigInt(42),
        amount: BigInt(1000),
        timelock: BigInt(1700000000),
      },
    } as any);

    const result = parseHtlcReceipt([mockLog]);

    expect(result).toEqual({
      contractMode: 'v2-escrow',
      contractAddress: '0xcontract',
      orderId: '42',
      amountWei: '1000',
      timelockUnixSeconds: 1700000000,
    });
  });

  test('parses v1 MainnetHTLC event successfully if v2 fails', () => {
    const mockLog = {
      address: '0xcontract',
      topics: ['0x1', '0x2'],
      data: '0xdata',
    };

    // First call (v2) throws
    vi.mocked(decodeEventLog).mockImplementationOnce(() => {
      throw new Error('not v2');
    });

    // Second call (v1) succeeds
    vi.mocked(decodeEventLog).mockReturnValueOnce({
      eventName: 'OrderCreated',
      args: {
        orderId: '0xorderid',
        amount: BigInt(2000),
        timelock: BigInt(1800000000),
      },
    } as any);

    const result = parseHtlcReceipt([mockLog]);

    expect(result).toEqual({
      contractMode: 'v1-mainnet-htlc',
      contractAddress: '0xcontract',
      orderId: '0xorderid',
      amountWei: '2000',
      timelockUnixSeconds: 1800000000,
    });
  });
});
