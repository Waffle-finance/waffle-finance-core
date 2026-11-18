// @vitest-environment jsdom

/**
 * User-safe transaction hash copy test — issue #965.
 *
 * Copying uses an injected clipboard abstraction so the host clipboard is
 * never touched. Success must be announced to assistive technology, and a
 * clipboard failure must leave the detail view intact.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import TransactionHash from './TransactionHash';

const HASH = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

describe('TransactionHash', () => {
  it('announces copy success to assistive technology', async () => {
    const copyFn = vi.fn(async () => {});
    render(<TransactionHash hash={HASH} copyFn={copyFn} />);

    await userEvent.click(screen.getByRole('button', { name: /copy transaction hash/i }));

    await waitFor(() => expect(copyFn).toHaveBeenCalledWith(HASH));
    const status = screen.getByRole('status');
    await waitFor(() => expect(status).toHaveTextContent('Transaction hash copied'));
  });

  it('keeps the detail view on clipboard failure (non-blocking)', async () => {
    const copyFn = vi.fn(async () => {
      throw new Error('clipboard unavailable');
    });
    render(<TransactionHash hash={HASH} copyFn={copyFn} />);

    await userEvent.click(screen.getByRole('button', { name: /copy transaction hash/i }));

    await waitFor(() => expect(copyFn).toHaveBeenCalledWith(HASH));
    // The detail view does not crash: the hash is still rendered.
    expect(screen.getByTestId('transaction-hash-value')).toHaveTextContent(HASH);
    expect(screen.getByRole('status')).toHaveTextContent(/copy failed/i);
  });

  it('keeps the hash selectable as text', () => {
    render(<TransactionHash hash={HASH} copyFn={vi.fn(async () => {})} />);

    const value = screen.getByTestId('transaction-hash-value');
    expect(value.tagName).toBe('CODE');
    expect(value).toHaveTextContent(HASH);
    // Selectable styling so users can always copy manually.
    expect(value.className).toMatch(/select-all/);
  });

  it('copy control is keyboard accessible', async () => {
    const copyFn = vi.fn(async () => {});
    render(<TransactionHash hash={HASH} copyFn={copyFn} />);

    const button = screen.getByRole('button', { name: /copy transaction hash/i });
    button.focus();
    expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(copyFn).toHaveBeenCalledWith(HASH));
  });
});
