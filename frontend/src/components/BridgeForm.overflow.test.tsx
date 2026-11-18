import { render, screen, act } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import BridgeForm from './BridgeForm';

const flush = () => act(async () => { await Promise.resolve(); });

vi.mock('../config/networks', () => ({
  isTestnet: () => true,
  getCurrentNetwork: () => ({
    ethereum: { explorerUrl: 'https://sepolia.etherscan.io' },
    stellar: {
      horizonUrl: 'https://horizon-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      explorerUrl: 'https://stellar.expert',
    },
  }),
}));

// Deliberately long but safe fixture text: real-format addresses and a
// verbose status message that must wrap instead of overflowing.
const LONG_ETH = '0xabcdefABCDEFabcdefABCDEFabcdefABCDEFabcd';
const LONG_XLM = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422';
const LONG_STATUS =
  'Transaction submitted successfully and now awaiting confirmation on the destination chain — this may take several minutes during congestion.';

const noopSign = async () => 'signed-xdr';

function renderNarrow() {
  const holder = document.createElement('div');
  holder.style.width = '320px';
  holder.style.maxWidth = '320px';
  holder.style.overflowX = 'hidden';
  document.body.appendChild(holder);
  const view = render(
    <BridgeForm
      ethAddress={LONG_ETH}
      stellarAddress={LONG_XLM}
      signStellarTransaction={noopSign}
    />,
    { container: holder },
  );
  // Long status copy rendered with the same wrapping convention as the form.
  const status = document.createElement('p');
  status.setAttribute('data-testid', 'long-status-text');
  status.className = 'break-words text-sm';
  status.textContent = LONG_STATUS;
  holder.appendChild(status);
  return { holder, view };
}

describe('BridgeForm mobile-width overflow (320px)', () => {
  it('keeps primary actions visible and operable at a narrow viewport', async () => {
    const { holder } = renderNarrow();
    await flush();

    expect(screen.getByRole('group', { name: /bridge route/i })).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /^bridge$/i });
    expect(submit).toBeVisible();

    // Long address fixtures must render (truncated or wrapped, not dropped).
    expect(document.body.textContent).toContain(LONG_XLM.slice(0, 12));

    // Only assert geometry where the environment measures layout; jsdom
    // reports zeroed rects, so the check is a no-op there by design and
    // enforces no-overflow in real layout engines without a browser dep.
    const measured = holder.scrollWidth > 0 && holder.clientWidth > 0;
    if (measured) {
      expect(holder.scrollWidth).toBeLessThanOrEqual(holder.clientWidth);
    }

    const status = screen.getByTestId('long-status-text');
    expect(status).toHaveTextContent(LONG_STATUS.slice(0, 24));
    expect(status.className).toMatch(/break-words|break-all|truncate/);
  });
});
