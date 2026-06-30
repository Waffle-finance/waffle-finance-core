export function sanitizeForLog<T>(obj: T, depth = 0): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return obj.replace(/0x[0-9a-fA-F]{16,}/gi, '[REDACTED_SECRET]') as unknown as T;
  }

  if (typeof obj === 'object') {
    if (depth >= 3) return '[MAX_DEPTH_REACHED]' as unknown as T;

    if (obj instanceof Error) {
      const sanitizedMessage = typeof obj.message === 'string' 
        ? obj.message.replace(/0x[0-9a-fA-F]{16,}/gi, '[REDACTED_SECRET]') 
        : obj.message;
        
      const sanitizedError = new Error(sanitizedMessage);
      sanitizedError.name = obj.name;
      
      if (typeof obj.stack === 'string') {
        sanitizedError.stack = obj.stack.replace(/0x[0-9a-fA-F]{16,}/gi, '[REDACTED_SECRET]');
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
