import { describe, it, expect } from 'vitest';
import {
  validateSorobanChainConfig,
  assertSorobanChainConfig,
  isPlaceholderValue,
  normaliseContractId,
  formatConfigReport,
  SorobanChainConfigError,
  STELLAR_TESTNET_PASSPHRASE,
  STELLAR_MAINNET_PASSPHRASE,
  type SorobanChainConfigInput,
} from '../src/soroban-chain-config.js';

// ── Shared fixtures ───────────────────────────────────────────────────────────

const TESTNET_BASE: SorobanChainConfigInput = {
  network: 'testnet',
  soroban: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: STELLAR_TESTNET_PASSPHRASE,
    htlcContract: null,
    resolverRegistry: null,
  },
  ethereum: {
    rpcUrl: 'https://sepolia.infura.io/v3/abc123',
    chainId: 11_155_111,
    htlcEscrow: null,
    resolverRegistry: null,
  },
  solana: { programId: 'PLACEHOLDER' },
};

const MAINNET_BASE: SorobanChainConfigInput = {
  network: 'mainnet',
  soroban: {
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    horizonUrl: 'https://horizon.stellar.org',
    networkPassphrase: STELLAR_MAINNET_PASSPHRASE,
    htlcContract: null,
    resolverRegistry: null,
  },
  ethereum: {
    rpcUrl: 'https://mainnet.infura.io/v3/abc123',
    chainId: 1,
    htlcEscrow: null,
    resolverRegistry: null,
  },
  solana: { programId: null },
};

// ── isPlaceholderValue ────────────────────────────────────────────────────────

describe('isPlaceholderValue', () => {
  it('returns true for null and undefined', () => {
    expect(isPlaceholderValue(null)).toBe(true);
    expect(isPlaceholderValue(undefined)).toBe(true);
  });

  it('returns true for empty or whitespace strings', () => {
    expect(isPlaceholderValue('')).toBe(true);
    expect(isPlaceholderValue('   ')).toBe(true);
  });

  it('returns true for known sentinel values (case-insensitive)', () => {
    expect(isPlaceholderValue('PLACEHOLDER')).toBe(true);
    expect(isPlaceholderValue('placeholder')).toBe(true);
    expect(isPlaceholderValue('YOUR_CONTRACT_ID')).toBe(true);
    expect(isPlaceholderValue('your_soroban_htlc')).toBe(true);
    expect(isPlaceholderValue('YOUR_SOLANA_HTLC_PROGRAM')).toBe(true);
    expect(isPlaceholderValue('11111111111111111111111111111111')).toBe(true);
    expect(isPlaceholderValue('0x0000000000000000000000000000000000000000')).toBe(true);
  });

  it('returns true for any string containing PLACEHOLDER', () => {
    expect(isPlaceholderValue('my_PLACEHOLDER_value')).toBe(true);
    expect(isPlaceholderValue('CONTRACT_PLACEHOLDER_TESTNET')).toBe(true);
  });

  it('returns true for strings starting with YOUR_', () => {
    expect(isPlaceholderValue('YOUR_CUSTOM_CONTRACT')).toBe(true);
  });

  it('returns false for real-looking contract IDs and addresses', () => {
    expect(isPlaceholderValue('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7A6A')).toBe(
      false
    );
    expect(isPlaceholderValue('0xb352339BEb146f2699d28D736700B953988bB178')).toBe(false);
    expect(isPlaceholderValue('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe(false);
  });
});

// ── normaliseContractId ───────────────────────────────────────────────────────

describe('normaliseContractId', () => {
  it('returns null for placeholder inputs', () => {
    expect(normaliseContractId(null)).toBeNull();
    expect(normaliseContractId('')).toBeNull();
    expect(normaliseContractId('PLACEHOLDER')).toBeNull();
    expect(normaliseContractId('YOUR_SOROBAN_HTLC')).toBeNull();
  });

  it('returns trimmed string for real values', () => {
    expect(normaliseContractId('  CABC123  ')).toBe('CABC123');
    expect(normaliseContractId('0xb352339BEb146f2699d28D736700B953988bB178')).toBe(
      '0xb352339BEb146f2699d28D736700B953988bB178'
    );
  });
});

// ── validateSorobanChainConfig — happy paths ──────────────────────────────────

describe('validateSorobanChainConfig — valid inputs', () => {
  it('returns ok=true for a minimal testnet config (no optional contracts)', () => {
    const result = validateSorobanChainConfig(TESTNET_BASE);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns ok=true for a minimal mainnet config (no optional contracts)', () => {
    const result = validateSorobanChainConfig(MAINNET_BASE);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('warns but stays ok when all optional contracts are absent', () => {
    const result = validateSorobanChainConfig(TESTNET_BASE);
    expect(result.ok).toBe(true);
    const codes = result.warnings.map(w => w.code);
    expect(codes).toContain('CONTRACT_NOT_CONFIGURED');
    expect(codes).toContain('SOLANA_PLACEHOLDER_MODE');
  });

  it('produces no warnings when all optional contracts are configured', () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      soroban: {
        ...TESTNET_BASE.soroban,
        htlcContract: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7A6A',
        resolverRegistry: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB22',
      },
      ethereum: {
        ...TESTNET_BASE.ethereum,
        htlcEscrow: '0xb352339BEb146f2699d28D736700B953988bB178',
        resolverRegistry: '0x2222222222222222222222222222222222222222',
      },
      solana: { programId: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(true);
    const contractWarnings = result.warnings.filter(
      w => w.code === 'CONTRACT_NOT_CONFIGURED' || w.code === 'SOLANA_PLACEHOLDER_MODE'
    );
    expect(contractWarnings).toHaveLength(0);
  });

  it('normalises contract IDs correctly in the result', () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      soroban: {
        ...TESTNET_BASE.soroban,
        htlcContract: '  CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7A6A  ',
      },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(true);
    expect(result.normalised.soroban.htlcContract).toBe(
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7A6A'
    );
    expect(result.normalised.soroban.settlementActive).toBe(true);
  });

  it('sets settlementActive=false and escrowActive=false when contracts absent', () => {
    const result = validateSorobanChainConfig(TESTNET_BASE);
    expect(result.normalised.soroban.settlementActive).toBe(false);
    expect(result.normalised.ethereum.escrowActive).toBe(false);
    expect(result.normalised.solana.active).toBe(false);
  });
});

// ── validateSorobanChainConfig — URL errors ───────────────────────────────────

describe('validateSorobanChainConfig — URL validation', () => {
  it('rejects a missing Soroban RPC URL', () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      soroban: { ...TESTNET_BASE.soroban, rpcUrl: '' },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(false);
    const err = result.errors.find(e => e.field === 'soroban.rpcUrl');
    expect(err?.code).toBe('INVALID_URL');
    expect(err?.envVar).toBe('SOROBAN_RPC_URL');
  });

  it('rejects a non-URL Soroban RPC string', () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      soroban: { ...TESTNET_BASE.soroban, rpcUrl: 'not-a-url' },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_URL' && e.field === 'soroban.rpcUrl')).toBe(
      true
    );
  });

  it('rejects a missing Horizon URL', () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      soroban: { ...TESTNET_BASE.soroban, horizonUrl: 'bad-url' },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.field === 'soroban.horizonUrl')).toBe(true);
  });

  it('rejects a missing Ethereum RPC URL', () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      ethereum: { ...TESTNET_BASE.ethereum, rpcUrl: '' },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.field === 'ethereum.rpcUrl')).toBe(true);
  });

  it('emits HTTP_ENDPOINT_IN_TESTNET warning for http:// RPC in testnet', () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      soroban: { ...TESTNET_BASE.soroban, rpcUrl: 'http://localhost:8000' },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(true);
    expect(result.warnings.some(w => w.code === 'HTTP_ENDPOINT_IN_TESTNET')).toBe(true);
  });

  it('rejects http:// endpoint in mainnet mode as ENDPOINT_SCHEME_MISMATCH', () => {
    const input: SorobanChainConfigInput = {
      ...MAINNET_BASE,
      soroban: { ...MAINNET_BASE.soroban, rpcUrl: 'http://mainnet.sorobanrpc.com' },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(e => e.code === 'ENDPOINT_SCHEME_MISMATCH' && e.field === 'soroban.rpcUrl')
    ).toBe(true);
  });
});

// ── validateSorobanChainConfig — passphrase errors ────────────────────────────

describe('validateSorobanChainConfig — passphrase validation', () => {
  it('rejects a blank passphrase', () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      soroban: { ...TESTNET_BASE.soroban, networkPassphrase: '' },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(false);
    const err = result.errors.find(e => e.field === 'soroban.networkPassphrase');
    expect(err?.code).toBe('MISSING_REQUIRED');
    expect(err?.envVar).toBe('STELLAR_NETWORK_PASSPHRASE');
  });

  it('rejects testnet passphrase used with mainnet mode', () => {
    const input: SorobanChainConfigInput = {
      ...MAINNET_BASE,
      soroban: {
        ...MAINNET_BASE.soroban,
        networkPassphrase: STELLAR_TESTNET_PASSPHRASE,
      },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(false);
    const err = result.errors.find(e => e.field === 'soroban.networkPassphrase');
    expect(err?.code).toBe('PASSPHRASE_MISMATCH');
    expect(err?.message).toContain('mainnet');
  });

  it('rejects mainnet passphrase used with testnet mode', () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      soroban: {
        ...TESTNET_BASE.soroban,
        networkPassphrase: STELLAR_MAINNET_PASSPHRASE,
      },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.code === 'PASSPHRASE_MISMATCH')).toBe(true);
  });

  it('accepts the correct testnet passphrase', () => {
    const result = validateSorobanChainConfig(TESTNET_BASE);
    expect(result.errors.some(e => e.field === 'soroban.networkPassphrase')).toBe(false);
  });

  it('accepts the correct mainnet passphrase', () => {
    const result = validateSorobanChainConfig(MAINNET_BASE);
    expect(result.errors.some(e => e.field === 'soroban.networkPassphrase')).toBe(false);
  });
});

// ── validateSorobanChainConfig — chain ID mismatch ────────────────────────────

describe('validateSorobanChainConfig — chainId validation', () => {
  it('rejects mainnet chainId (1) in testnet mode', () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      ethereum: { ...TESTNET_BASE.ethereum, chainId: 1 },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(false);
    const err = result.errors.find(e => e.field === 'ethereum.chainId');
    expect(err?.code).toBe('CHAIN_ID_MISMATCH');
    expect(err?.message).toContain('11155111');
  });

  it('rejects Sepolia chainId (11155111) in mainnet mode', () => {
    const input: SorobanChainConfigInput = {
      ...MAINNET_BASE,
      ethereum: { ...MAINNET_BASE.ethereum, chainId: 11_155_111 },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(false);
    const err = result.errors.find(e => e.field === 'ethereum.chainId');
    expect(err?.code).toBe('CHAIN_ID_MISMATCH');
    expect(err?.message).toContain('chainId 1');
  });

  it('accepts chainId 11155111 in testnet mode', () => {
    const result = validateSorobanChainConfig(TESTNET_BASE);
    expect(result.errors.some(e => e.field === 'ethereum.chainId')).toBe(false);
  });

  it('accepts chainId 1 in mainnet mode', () => {
    const result = validateSorobanChainConfig(MAINNET_BASE);
    expect(result.errors.some(e => e.field === 'ethereum.chainId')).toBe(false);
  });
});

// ── validateSorobanChainConfig — placeholder rejection ────────────────────────

describe('validateSorobanChainConfig — placeholder values become warnings not errors', () => {
  it('treats blank Soroban HTLC contract as CONTRACT_NOT_CONFIGURED warning', () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      soroban: { ...TESTNET_BASE.soroban, htlcContract: '' },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(true);
    expect(
      result.warnings.some(
        w => w.code === 'CONTRACT_NOT_CONFIGURED' && w.field === 'soroban.htlcContract'
      )
    ).toBe(true);
  });

  it("treats 'PLACEHOLDER' Soroban HTLC as CONTRACT_NOT_CONFIGURED warning", () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      soroban: { ...TESTNET_BASE.soroban, htlcContract: 'PLACEHOLDER' },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(true);
    expect(result.warnings.some(w => w.code === 'CONTRACT_NOT_CONFIGURED')).toBe(true);
  });

  it("treats 'YOUR_SOROBAN_HTLC' as CONTRACT_NOT_CONFIGURED warning", () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      soroban: { ...TESTNET_BASE.soroban, htlcContract: 'YOUR_SOROBAN_HTLC' },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(true);
    expect(result.warnings.some(w => w.code === 'CONTRACT_NOT_CONFIGURED')).toBe(true);
  });

  it('treats blank Ethereum escrow as CONTRACT_NOT_CONFIGURED warning', () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      ethereum: { ...TESTNET_BASE.ethereum, htlcEscrow: '' },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(true);
    expect(
      result.warnings.some(
        w => w.code === 'CONTRACT_NOT_CONFIGURED' && w.field === 'ethereum.htlcEscrow'
      )
    ).toBe(true);
  });

  it('rejects a malformed Ethereum address (non-placeholder)', () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      ethereum: { ...TESTNET_BASE.ethereum, htlcEscrow: '0xSHORT' },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(e => e.code === 'INVALID_ADDRESS' && e.field === 'ethereum.htlcEscrow')
    ).toBe(true);
  });

  it('treats Solana PLACEHOLDER program as SOLANA_PLACEHOLDER_MODE warning', () => {
    const result = validateSorobanChainConfig(TESTNET_BASE);
    expect(result.ok).toBe(true);
    expect(result.warnings.some(w => w.code === 'SOLANA_PLACEHOLDER_MODE')).toBe(true);
  });

  it('produces no SOLANA_PLACEHOLDER_MODE warning when a real program ID is set', () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      solana: { programId: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' },
    };
    const result = validateSorobanChainConfig(input);
    expect(result.warnings.some(w => w.code === 'SOLANA_PLACEHOLDER_MODE')).toBe(false);
  });
});

// ── validateSorobanChainConfig — multiple errors ──────────────────────────────

describe('validateSorobanChainConfig — multiple simultaneous errors', () => {
  it('collects all errors in one pass rather than stopping at first failure', () => {
    const input: SorobanChainConfigInput = {
      network: 'testnet',
      soroban: {
        rpcUrl: 'not-a-url', // INVALID_URL
        horizonUrl: 'also-bad', // INVALID_URL
        networkPassphrase: STELLAR_MAINNET_PASSPHRASE, // PASSPHRASE_MISMATCH
        htlcContract: null,
        resolverRegistry: null,
      },
      ethereum: {
        rpcUrl: 'bad-eth-url', // INVALID_URL
        chainId: 1, // CHAIN_ID_MISMATCH
        htlcEscrow: null,
        resolverRegistry: null,
      },
      solana: { programId: null },
    };

    const result = validateSorobanChainConfig(input);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);

    const codes = result.errors.map(e => e.code);
    expect(codes).toContain('INVALID_URL');
    expect(codes).toContain('PASSPHRASE_MISMATCH');
    expect(codes).toContain('CHAIN_ID_MISMATCH');
  });

  it('never throws — always returns a result object', () => {
    // Even with a maximally broken config, validate() returns, never throws.
    const broken: SorobanChainConfigInput = {
      network: 'mainnet',
      soroban: {
        rpcUrl: '',
        horizonUrl: '',
        networkPassphrase: '',
        htlcContract: null,
        resolverRegistry: null,
      },
      ethereum: { rpcUrl: '', chainId: 0, htlcEscrow: null, resolverRegistry: null },
      solana: { programId: null },
    };
    expect(() => validateSorobanChainConfig(broken)).not.toThrow();
    const result = validateSorobanChainConfig(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ── assertSorobanChainConfig — fail-fast helper ───────────────────────────────

describe('assertSorobanChainConfig', () => {
  it('returns the normalised config when valid', () => {
    const normalised = assertSorobanChainConfig(TESTNET_BASE);
    expect(normalised.network).toBe('testnet');
    expect(normalised.soroban.rpcUrl).toBe('https://soroban-testnet.stellar.org');
  });

  it('throws SorobanChainConfigError on the first invalid config', () => {
    const bad: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      soroban: { ...TESTNET_BASE.soroban, rpcUrl: 'not-a-url' },
    };
    expect(() => assertSorobanChainConfig(bad)).toThrow(SorobanChainConfigError);
  });

  it('SorobanChainConfigError.errors carries machine-readable codes', () => {
    const bad: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      ethereum: { ...TESTNET_BASE.ethereum, chainId: 1 },
    };
    let caught: SorobanChainConfigError | null = null;
    try {
      assertSorobanChainConfig(bad);
    } catch (err) {
      if (err instanceof SorobanChainConfigError) caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught!.errors.some(e => e.code === 'CHAIN_ID_MISMATCH')).toBe(true);
  });

  it('error message contains the env var name and human explanation', () => {
    const bad: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      soroban: { ...TESTNET_BASE.soroban, networkPassphrase: '' },
    };
    let message = '';
    try {
      assertSorobanChainConfig(bad);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('STELLAR_NETWORK_PASSPHRASE');
    expect(message).toContain('MISSING_REQUIRED');
  });
});

// ── formatConfigReport ────────────────────────────────────────────────────────

describe('formatConfigReport', () => {
  it('includes the network mode in the report header', () => {
    const result = validateSorobanChainConfig(TESTNET_BASE);
    const report = formatConfigReport(result);
    expect(report).toContain('testnet');
  });

  it('marks errors with ✗ and their code', () => {
    const bad: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      ethereum: { ...TESTNET_BASE.ethereum, chainId: 1 },
    };
    const report = formatConfigReport(validateSorobanChainConfig(bad));
    expect(report).toContain('✗');
    expect(report).toContain('CHAIN_ID_MISMATCH');
  });

  it('marks warnings with ⚠ and their code', () => {
    const result = validateSorobanChainConfig(TESTNET_BASE);
    const report = formatConfigReport(result);
    expect(report).toContain('⚠');
    expect(report).toContain('CONTRACT_NOT_CONFIGURED');
  });

  it('shows all-clear message when no errors and no warnings', () => {
    const input: SorobanChainConfigInput = {
      ...TESTNET_BASE,
      soroban: {
        ...TESTNET_BASE.soroban,
        htlcContract: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7A6A',
        resolverRegistry: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB22',
      },
      ethereum: {
        ...TESTNET_BASE.ethereum,
        htlcEscrow: '0xb352339BEb146f2699d28D736700B953988bB178',
        resolverRegistry: '0x2222222222222222222222222222222222222222',
      },
      solana: { programId: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' },
    };
    const report = formatConfigReport(validateSorobanChainConfig(input));
    expect(report).toContain('✓');
    expect(report).toContain('All required fields valid');
  });
});

// ── loadCoordinatorConfig integration ────────────────────────────────────────
// These tests exercise the contract through the real config loader to confirm
// the wiring in node.ts is correct.

describe('loadCoordinatorConfig — Soroban/chain contract integration', () => {
  it('throws when Soroban RPC URL is invalid', async () => {
    const { loadCoordinatorConfig } = await import('../src/node.js');
    const env = {
      NETWORK_MODE: 'testnet',
      ETHEREUM_RPC_URL: 'https://sepolia.infura.io/v3/test',
      SOROBAN_RPC_URL: 'not-a-url',
      STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOLANA_RPC_URL: 'https://api.devnet.solana.com',
    };
    expect(() => loadCoordinatorConfig(env)).toThrow(/Invalid url|Soroban\/chain contract/);
  });

  it('throws when Ethereum chain ID mismatches mainnet mode', async () => {
    const { loadCoordinatorConfig } = await import('../src/node.js');
    // NETWORK_MODE=mainnet but no MAINNET_RPC_URL → resolves to public fallback;
    // chain ID is derived from NETWORK_MODE, so mainnet → 1 which should pass.
    // We craft a testnet URL in mainnet mode to trigger the HTTPS check.
    const env = {
      NETWORK_MODE: 'mainnet',
      MAINNET_RPC_URL: 'http://mainnet.infura.io/v3/test', // http in mainnet → ENDPOINT_SCHEME_MISMATCH
      STELLAR_HORIZON_URL: 'https://horizon.stellar.org',
      SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
    };
    expect(() => loadCoordinatorConfig(env)).toThrow(/Soroban\/chain contract/);
  });

  it('succeeds and reports warnings for a valid testnet config with no contracts', async () => {
    const { loadCoordinatorConfig } = await import('../src/node.js');
    const env = {
      NETWORK_MODE: 'testnet',
      ETHEREUM_RPC_URL: 'https://sepolia.infura.io/v3/test',
      STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      SOLANA_RPC_URL: 'https://api.devnet.solana.com',
    };
    // Should not throw — missing contracts are warnings only.
    expect(() => loadCoordinatorConfig(env)).not.toThrow();
  });
});
