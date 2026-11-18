import { useState } from 'react';

export interface TransactionHashProps {
  hash: string;
  /**
   * Clipboard abstraction. Defaults to `navigator.clipboard.writeText` so
   * tests can inject a deterministic mock without touching the host
   * clipboard.
   */
  copyFn?: (text: string) => Promise<void>;
}

type CopyState = 'idle' | 'copied' | 'failed';

function defaultCopy(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

/**
 * User-safe transaction hash display with copy support (issue #965).
 *
 * - The hash stays rendered as selectable text (`<code>` with
 *   `select-all`) so it can always be copied manually.
 * - Copy confirmation is announced through an `aria-live` status region.
 * - A clipboard failure shows a non-blocking notice and never unmounts
 *   the detail view.
 */
export default function TransactionHash({ hash, copyFn = defaultCopy }: TransactionHashProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  const onCopy = async () => {
    try {
      await copyFn(hash);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <div>
      <code className="select-all break-all" data-testid="transaction-hash-value">
        {hash}
      </code>
      <button type="button" onClick={() => void onCopy()} aria-label="Copy transaction hash">
        Copy
      </button>
      <div role="status" aria-live="polite" aria-atomic="true">
        {copyState === 'copied' ? 'Transaction hash copied' : null}
        {copyState === 'failed' ? 'Copy failed — select the hash to copy it manually' : null}
      </div>
    </div>
  );
}
