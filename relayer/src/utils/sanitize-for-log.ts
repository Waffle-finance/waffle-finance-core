/**
 * Redact secrets from a single string.
 *
 * Handles two categories of sensitive material:
 *  1. Long hex strings (0x + 16+ hex chars) — private keys, preimages, hashlocks, tx hashes.
 *  2. Credentials embedded in URLs (protocol://user:password@host) — RPC endpoint credentials.
 *
 * Non-sensitive context (host, port, path, error category) is preserved so operators
 * can still diagnose the failure.
 */
export function sanitizeString(str: string): string {
  return str
    // Redact long hex secrets: 0x followed by 16+ hex characters
    .replace(/0x[0-9a-fA-F]{16,}/gi, '[REDACTED_SECRET]')
    // Redact credentials in URLs: protocol://username:password@host
    // Preserves the protocol and host so the endpoint remains diagnosable
    .replace(/(\w+:\/\/)[^:/\s]+:[^@/\s]+@/gi, '$1[REDACTED_CREDENTIALS]@');
}

export function sanitizeForLog<T>(obj: T, depth = 0): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return sanitizeString(obj) as unknown as T;
  }

  if (typeof obj === 'object') {
    if (depth >= 3) return '[MAX_DEPTH_REACHED]' as unknown as T;

    if (obj instanceof Error) {
      const sanitizedMessage = typeof obj.message === 'string'
        ? sanitizeString(obj.message)
        : obj.message;

      const sanitizedError = new Error(sanitizedMessage);
      sanitizedError.name = obj.name;

      if (typeof obj.stack === 'string') {
        sanitizedError.stack = sanitizeString(obj.stack);
      } else {
        sanitizedError.stack = obj.stack;
      }
      
      for (const key of Object.keys(obj)) {
        if (key !== 'name' && key !== 'message' && key !== 'stack') {
          (sanitizedError as any)[key] = sanitizeForLog((obj as any)[key], depth + 1);
        }
      }
      return sanitizedError as unknown as T;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => sanitizeForLog(item, depth + 1)) as unknown as T;
    }

    const sanitizedObj: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      sanitizedObj[key] = sanitizeForLog((obj as Record<string, unknown>)[key], depth + 1);
    }
    return sanitizedObj as unknown as T;
  }

  return obj;
}
