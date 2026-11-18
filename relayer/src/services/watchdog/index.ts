/**
 * @fileoverview Watchdog Services Module
 * @description Watchdog service with explicit timing, escalation, and recovery
 */

// Export interfaces
export * from './IWatchdogService.js';

// Export configuration
export * from './watchdog.js';

// Export detection
export * from './StuckOrderDetection.js';

// Export services
export { WatchdogService } from './WatchdogService.js';
export { EscalationService } from './EscalationService.js';
