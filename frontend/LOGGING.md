# Frontend Structured Logging Documentation

## Overview

The frontend now includes a comprehensive structured logging utility that captures wallet connection flows, transaction submissions, network operations, and API interactions. This makes debugging production issues and QA failures much easier.

## Features

### 🔐 Security First
- **Sensitive Data Masking**: Automatically masks wallet addresses, private keys, XDR strings, and other sensitive data in logs
- **No Personal Data Logging**: Only logs transaction IDs, status, and non-sensitive metadata
- **Development-Only**: Logging is disabled in production builds by default

### 📊 Structured Events
The logger provides typed event categories for clear, consistent logging:
- **Wallet Events**: `wallet_connect`, `wallet_disconnect`, `wallet_error`, `wallet_state_change`
- **Transaction Events**: `transaction_start`, `transaction_sign`, `transaction_submit`, `transaction_confirm`, `transaction_error`
- **Network Events**: `network_check`, `network_switch`, `network_error`
- **API Events**: `api_request`, `api_response`, `api_error`
- **Validation Events**: `validation_error`
- **State Events**: `state_change`

### ⚡ Lightweight & Optional
- Zero overhead in production
- No external dependencies required
- Can be enabled on-demand via localStorage flag

## Usage

### Basic Setup

Import the logger in any component or hook:

```typescript
import { logger } from '../utils/logger';
```

### Logging Wallet Events

```typescript
// Successful connection
logger.walletConnect('MetaMask', '0x1234...', { network: 'mainnet' });

// Disconnection
logger.walletDisconnect('MetaMask');

// Error handling
logger.walletError('Freighter', error, { action: 'connection_attempt' });
```

### Logging Transactions

```typescript
// Transaction start
logger.transactionStart('order-123', { 
  direction: 'ETH → XLM',
  amount: '1.5'
});

// Transaction signing
logger.transactionSign('order-123', 'MetaMask', { method: 'eth_signTransaction' });

// Transaction submitted
logger.transactionSubmit('order-123', '0x1a2b3c...', { explorerUrl: 'https://...' });

// Transaction confirmed
logger.transactionConfirm('order-123', '0x1a2b3c...', 12345678);

// Transaction error
logger.transactionError('order-123', error, { action: 'confirmation_timeout' });
```

### Logging Network Operations

```typescript
// Network check
logger.networkCheck('0x1', '0xaa36a7', { status: 'mismatch' });

// Network switch
logger.networkSwitch('Ethereum', 'Sepolia', { action: 'user_initiated' });

// Network error
logger.networkError(error, { code: 'RPC_UNREACHABLE' });
```

### Logging API Calls

```typescript
// API request
logger.apiRequest('POST', '/api/orders/create', { orderId: 'order-123' });

// API response
logger.apiResponse('POST', '/api/orders/create', 200, { orderId: 'order-123' });

// API error
logger.apiError('POST', '/api/orders/create', error, { orderId: 'order-123' });
```

### Generic Event Logging

```typescript
logger.event('wallet_connect', 'User connected wallet', { wallet: 'MetaMask' }, 'info');
```

## Enabling Debug Logging

### Method 1: Environment Variable
Set `VITE_DEBUG_LOGGING=true` in your `.env` file or `.env.local`:

```bash
# .env.local
VITE_DEBUG_LOGGING=true
```

### Method 2: Browser Console
Enable logging from the browser console for the current session:

```javascript
// In browser console:
logger.enableDebug();

// Disable:
logger.disableDebug();

// Check status:
logger.isDebugEnabled(); // returns true/false
```

The browser setting persists in localStorage as `waffle_debug_logging` and survives page refreshes.

### Method 3: Command Line
Enable for development server:

```bash
VITE_DEBUG_LOGGING=true npm run dev
```

## Log Output Format

Logs are formatted with:
- **Event type** in square brackets (e.g., `[wallet_connect]`)
- **Color-coded level** (info=blue, warn=orange, error=red)
- **Structured data** as a JavaScript object for easy inspection in DevTools

Example output:
```
[wallet_connect] Connected to MetaMask wallet
{wallet: "MetaMask", address: "0x1234...5678"}

[transaction_submit] Transaction submitted: 0x1a2b3c...
{orderId: "order-123", txHash: "0x1a2b3c...", explorerUrl: "https://etherscan.io/tx/..."}

[api_response] POST /api/orders/create - 200
{orderId: "order-123", mode: "testnet"}
```

## Sensitive Data Protection

### What Gets Masked
- Ethereum addresses (0x...)
- Private keys and hex secrets (64+ hex chars)
- XDR transaction strings (Stellar)
- Any field named: `address`, `privateKey`, `secret`, `password`, `token`, `key`, `xdr`

### Example
```typescript
// Input:
logger.transactionSign('order-123', 'MetaMask', {
  xdr: 'AAAAAgAAAABIW...(500 chars)...',
  address: '0x1234567890123456789012345678901234567890'
});

// Output:
logger.transactionSign('order-123', 'MetaMask', {
  xdr: 'AAAAA...(truncated)...',
  address: '0x1234...7890'
});
```

Non-sensitive data is always included:
```typescript
logger.event('transaction_start', 'Test', {
  status: 'pending',        // ✅ Included
  amount: '1.5',            // ✅ Included
  chainId: '0x1',           // ✅ Included
  address: '0x...',         // 🔒 Masked
  privateKey: '0x...'       // 🔒 Masked
});
```

## Testing

Unit tests are included in `frontend/src/utils/logger.test.ts`:

```bash
npm run test  # Run all tests
npm run test -- logger.test.ts  # Run logger tests only
```

Test coverage includes:
- All event types
- Sensitive data masking
- Debug mode control
- Log level handling
- Nested object sanitization

## Performance Considerations

- **Zero overhead in production**: All logging is disabled by default
- **Minimal overhead in dev mode**: ~1-2ms per log entry
- **No memory leaks**: Logger uses console directly, no event storage
- **No blocking I/O**: All logging is synchronous and non-blocking

## Best Practices

### ✅ DO

```typescript
// Use event types for consistency
logger.transactionStart('order-123', { amount: '1.5' });

// Include relevant context
logger.apiError('POST', '/api/orders', error, { orderId: 'order-123' });

// Use appropriate levels
logger.event('transaction_confirm', 'TX confirmed', {}, 'info');
logger.event('validation_error', 'Invalid input', {}, 'warn');
```

### ❌ DON'T

```typescript
// Avoid console.log directly
console.log('Transaction:', tx); // ❌ Unstructured, not masked

// Don't log sensitive data explicitly
logger.event('any_event', 'Key=' + privateKey); // ❌ Data not masked this way

// Don't use for high-frequency events
logger.event('mousemove', 'User moved mouse'); // ❌ Too verbose
```

## Troubleshooting

### Logs Not Appearing?

1. **Check if debug mode is enabled**:
   ```javascript
   logger.isDebugEnabled() // Should return true
   ```

2. **Check environment**:
   - Development mode: `import.meta.env.DEV` should be true
   - Staging/QA: May need to enable via localStorage

3. **Check browser console levels**:
   - Open DevTools → Console tab
   - Make sure "All Levels" is selected in the filter dropdown

### Logs Showing Sensitive Data?

If you see unmasked data, it might not match masking patterns. Check:
1. Field names: Are they in the sensitive field list?
2. Format: Are they valid hex addresses (0x + 40 chars for ETH)?
3. Report: File an issue if sensitive data isn't being masked

## Integration with Error Tracking

The structured logs can be integrated with error tracking services:

```typescript
// Example: Send to Sentry
if (logger.isDebugEnabled()) {
  Sentry.captureMessage(JSON.stringify({
    event: 'transaction_error',
    orderId: 'order-123',
    error: error.message
  }));
}
```

## Future Enhancements

Potential improvements for future versions:
- Remote logging to debug server (for production debugging)
- Log level filtering by event type
- Performance metrics collection
- Session replay integration
- Distributed tracing support
