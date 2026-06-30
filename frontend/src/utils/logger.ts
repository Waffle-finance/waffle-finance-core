/**
 * Logger utility for development mode only
 * In production, all logs are disabled
 */

/// <reference types="vite/client" />

import { featureFlags } from '../config/feature-flags';

export const logger = {
  log: (...args: any[]) => {
    if (featureFlags.debugMode) {
      console.log(...args);
    }
  },
  warn: (...args: any[]) => {
    if (featureFlags.debugMode) {
      console.warn(...args);
    }
  },
  error: (...args: any[]) => {
    if (featureFlags.debugMode) {
      console.error(...args);
    }
  },
  info: (...args: any[]) => {
    if (featureFlags.debugMode) {
      console.info(...args);
    }
  },
};

// Export as default for easier imports
export default logger;
