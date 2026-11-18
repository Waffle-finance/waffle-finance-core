/**
 * @fileoverview Event history management for 1inch Fusion+ system
 * @description Comprehensive event tracking, replay, and archival system
 */

import { EventType, EventMessage } from './event-handlers.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getLogger } from '../logger.js';

const log = getLogger().child({ component: 'event-history' });

// Event history storage configuration
export interface EventHistoryConfig {
  maxMemoryEvents: number;
  maxDiskEvents: number;
  archiveAfterDays: number;
  compressionEnabled: boolean;
  indexingEnabled: boolean;
  storageDirectory: string;
}

// Event index for fast searching
export interface EventIndex {
  byOrderHash: Map<string, EventMessage[]>;
  byResolver: Map<string, EventMessage[]>;
  byChainId: Map<number, EventMessage[]>;
  byEventType: Map<EventType, EventMessage[]>;
  byTimeRange: Map<string, EventMessage[]>; // ISO date string -> events
}

// Event query parameters
export interface EventQuery {
  eventTypes?: EventType[];
  orderHashes?: string[];
  resolvers?: string[];
  chainIds?: number[];
  timeRange?: {
    start: number;
    end: number;
  };
  limit?: number;
  offset?: number;
  sortBy?: 'timestamp' | 'eventType' | 'orderHash';
  sortOrder?: 'asc' | 'desc';
  includeMetadata?: boolean;
}

// Event statistics
export interface EventStatistics {
  totalEvents: number;
  eventsByType: Record<EventType, number>;
  eventsByChain: Record<number, number>;
  eventsByResolver: Record<string, number>;
  timeRanges: {
    last1Hour: number;
    last24Hours: number;
    last7Days: number;
    last30Days: number;
  };
  averageEventsPerMinute: number;
  peakEventsPerMinute: number;
  mostActiveOrders: Array<{
    orderHash: string;
    eventCount: number;
    lastActivity: number;
  }>;
}

// Event batch for efficient processing
export interface EventBatch {
  id: string;
  events: EventMessage[];
  timestamp: number;
  compressed: boolean;
  checksum: string;
}

// Event replay configuration
export interface EventReplayConfig {
  startTime: number;
  endTime: number;
  eventTypes?: EventType[];
  orderHashes?: string[];
  playbackSpeed: number; // 1.0 = real time, 2.0 = 2x speed
  autoReplay: boolean;
  callback: (event: EventMessage) => void;
}

export class EventHistoryManager {
  private config: EventHistoryConfig;
  private memoryEvents: EventMessage[] = [];
  private eventIndex: EventIndex;
  private statistics: EventStatistics;
  private replayTimeouts: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: Partial<EventHistoryConfig> = {}) {
    this.config = {
      maxMemoryEvents: 1000,
      maxDiskEvents: 10000,
      archiveAfterDays: 30,
      compressionEnabled: true,
      indexingEnabled: true,
      storageDirectory: './event-history',
      ...config
    };

    this.eventIndex = {
      byOrderHash: new Map(),
      byResolver: new Map(),
      byChainId: new Map(),
      byEventType: new Map(),
      byTimeRange: new Map()
    };

    this.statistics = this.initializeStatistics();
    this.ensureStorageDirectory();
    this.loadPersistedEvents();
  }

  /**
   * Add event to history
   */
  addEvent(event: EventMessage): void {
    // Add to memory
    this.memoryEvents.push(event);
    
    // Update index
    if (this.config.indexingEnabled) {
      this.updateIndex(event);
    }

    // Update statistics
    this.updateStatistics(event);

    // Check memory limit
    if (this.memoryEvents.length > this.config.maxMemoryEvents) {
      this.persistOldestEvents();
    }

    log.debug({ eventType: event.eventType, orderHash: event.metadata.orderHash }, 'event added to history');
  }

  /**
   * Query events with filtering and pagination
   */
  queryEvents(query: EventQuery): {
    events: EventMessage[];
    pagination: {
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    };
  } {
    let events: EventMessage[] = [];

    // Use index for efficient querying if possible
    if (this.config.indexingEnabled) {
      events = this.queryFromIndex(query);
    } else {
      events = this.queryFromMemory(query);
    }

    // Apply additional filters
    events = this.applyFilters(events, query);

    // Sort events
    events = this.sortEvents(events, query.sortBy || 'timestamp', query.sortOrder || 'desc');

    // Apply pagination
    const offset = query.offset || 0;
    const limit = query.limit || 100;
    const paginatedEvents = events.slice(offset, offset + limit);

    return {
      events: paginatedEvents,
      pagination: {
        total: events.length,
        limit,
        offset,
        hasMore: offset + limit < events.length
      }
    };
  }

  /**
   * Get event statistics
   */
  getStatistics(): EventStatistics {
    return { ...this.statistics };
  }

  /**
   * Start event replay
   */
  startReplay(config: EventReplayConfig): string {
    const replayId = this.generateId();
    
    // Query events for replay
    const events = this.queryEvents({
      timeRange: {
        start: config.startTime,
        end: config.endTime
      },
      eventTypes: config.eventTypes,
      orderHashes: config.orderHashes,
      sortBy: 'timestamp',
      sortOrder: 'asc'
    }).events;

    log.info({ replayId, eventCount: events.length }, 'starting replay');

    // Calculate timing
    const startTime = Date.now();
    const firstEventTime = events[0]?.timestamp || config.startTime;

    events.forEach((event, index) => {
      const eventDelay = ((event.timestamp - firstEventTime) / config.playbackSpeed);
      const timeout = setTimeout(() => {
        config.callback(event);
        
        // Remove timeout from map when complete
        if (index === events.length - 1) {
          this.replayTimeouts.delete(replayId);
          log.info({ replayId }, 'replay completed');
        }
      }, eventDelay);

      this.replayTimeouts.set(`${replayId}-${index}`, timeout);
    });

    return replayId;
  }

  /**
   * Stop event replay
   */
  stopReplay(replayId: string): boolean {
    let stopped = false;
    
    // Clear all timeouts for this replay
    this.replayTimeouts.forEach((timeout, key) => {
      if (key.startsWith(replayId)) {
        clearTimeout(timeout);
        this.replayTimeouts.delete(key);
        stopped = true;
      }
    });

    if (stopped) {
      log.info({ replayId }, 'replay stopped');
    }

    return stopped;
  }

  /**
   * Export events to file
   */
  exportEvents(query: EventQuery, format: 'json' | 'csv' = 'json'): string {
    const events = this.queryEvents(query).events;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `events-export-${timestamp}.${format}`;
    const filepath = join(this.config.storageDirectory, filename);

    let content: string;
    
    if (format === 'json') {
      content = JSON.stringify(events, null, 2);
    } else {
      // CSV format
      const headers = ['eventId', 'eventType', 'timestamp', 'orderHash', 'resolver', 'chainId', 'data'];
      const rows = events.map(event => [
        event.eventId,
        event.eventType,
        event.timestamp,
        event.metadata.orderHash || '',
        event.metadata.resolver || '',
        event.metadata.chainId || '',
        JSON.stringify(event.data)
      ]);
      
      content = [headers, ...rows].map(row => row.join(',')).join('\n');
    }

    writeFileSync(filepath, content);
    log.info({ eventCount: events.length, filename }, 'events exported');
    
    return filepath;
  }

  /**
   * Archive old events
   */
  archiveOldEvents(): void {
    const cutoffDate = Date.now() - (this.config.archiveAfterDays * 24 * 60 * 60 * 1000);
    
    // Find events to archive
    const eventsToArchive = this.memoryEvents.filter(event => event.timestamp < cutoffDate);
    
    if (eventsToArchive.length === 0) {
      log.debug('no events to archive');
      return;
    }

    // Create archive batch
    const archiveBatch: EventBatch = {
      id: this.generateId(),
      events: eventsToArchive,
      timestamp: Date.now(),
      compressed: this.config.compressionEnabled,
      checksum: this.calculateChecksum(eventsToArchive)
    };

    // Save to disk
    const archiveFilename = `archive-${new Date().toISOString().slice(0, 10)}.json`;
    const archivePath = join(this.config.storageDirectory, 'archives', archiveFilename);
    
    this.ensureDirectory(join(this.config.storageDirectory, 'archives'));
    
    let content = JSON.stringify(archiveBatch);
    if (this.config.compressionEnabled) {
      // Simple compression simulation (in real implementation, use zlib)
      content = content.replace(/\s+/g, ' ');
    }
    
    writeFileSync(archivePath, content);

    // Remove from memory
    this.memoryEvents = this.memoryEvents.filter(event => event.timestamp >= cutoffDate);
    
    // Update index
    this.rebuildIndex();

    log.info({ archivedCount: eventsToArchive.length, archiveFilename }, 'events archived');
  }

  /**
   * Search events by text query
   */
  searchEvents(textQuery: string, options: {
    fields?: ('eventType' | 'orderHash' | 'resolver' | 'data')[];
    limit?: number;
    caseSensitive?: boolean;
  } = {}): EventMessage[] {
    const { fields = ['eventType', 'orderHash', 'resolver', 'data'], limit = 100, caseSensitive = false } = options;
    
    const query = caseSensitive ? textQuery : textQuery.toLowerCase();
    const results: EventMessage[] = [];

    for (const event of this.memoryEvents) {
      if (results.length >= limit) break;

      let matches = false;

      for (const field of fields) {
        let fieldValue = '';
        
        switch (field) {
          case 'eventType':
            fieldValue = event.eventType;
            break;
          case 'orderHash':
            fieldValue = event.metadata.orderHash || '';
            break;
          case 'resolver':
            fieldValue = event.metadata.resolver || '';
            break;
          case 'data':
            fieldValue = JSON.stringify(event.data);
            break;
        }

        if (!caseSensitive) {
          fieldValue = fieldValue.toLowerCase();
        }

        if (fieldValue.includes(query)) {
          matches = true;
          break;
        }
      }

      if (matches) {
        results.push(event);
      }
    }

    return results;
  }

  /**
   * Get event timeline for visualization
   */
  getEventTimeline(options: {
    granularity: 'minute' | 'hour' | 'day';
    eventTypes?: EventType[];
    timeRange?: { start: number; end: number };
  }): Array<{
    timestamp: number;
    eventCount: number;
    eventTypes: Record<EventType, number>;
  }> {
    const { granularity, eventTypes, timeRange } = options;
    
    let events = this.memoryEvents;
    
    // Apply filters
    if (eventTypes) {
      events = events.filter(event => eventTypes.includes(event.eventType));
    }
    
    if (timeRange) {
      events = events.filter(event => 
        event.timestamp >= timeRange.start && event.timestamp <= timeRange.end
      );
    }

    // Group by time granularity
    const timelineMap = new Map<number, { count: number; types: Map<EventType, number> }>();
    
    const getTimeKey = (timestamp: number): number => {
      const date = new Date(timestamp);
      switch (granularity) {
        case 'minute':
          return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()).getTime();
        case 'hour':
          return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).getTime();
        case 'day':
          return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
      }
    };

    events.forEach(event => {
      const timeKey = getTimeKey(event.timestamp);
      
      if (!timelineMap.has(timeKey)) {
        timelineMap.set(timeKey, { count: 0, types: new Map() });
      }
      
      const timeData = timelineMap.get(timeKey)!;
      timeData.count++;
      timeData.types.set(event.eventType, (timeData.types.get(event.eventType) || 0) + 1);
    });

    // Convert to array and sort
    return Array.from(timelineMap.entries())
      .map(([timestamp, data]) => ({
        timestamp,
        eventCount: data.count,
        eventTypes: Object.fromEntries(data.types) as Record<EventType, number>
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    // Stop all active replays
    this.replayTimeouts.forEach(timeout => clearTimeout(timeout));
    this.replayTimeouts.clear();

    // Archive remaining events
    this.archiveOldEvents();

    log.info('event history manager cleaned up');
  }

  // Private methods

  private queryFromIndex(query: EventQuery): EventMessage[] {
    let events: EventMessage[] = [];

    // Use most selective index first
    if (query.orderHashes && query.orderHashes.length > 0) {
      const orderEvents = query.orderHashes.flatMap(hash => 
        this.eventIndex.byOrderHash.get(hash) || []
      );
      events = events.length === 0 ? orderEvents : events.filter(e => orderEvents.includes(e));
    }

    if (query.eventTypes && query.eventTypes.length > 0) {
      const typeEvents = query.eventTypes.flatMap(type => 
        this.eventIndex.byEventType.get(type) || []
      );
      events = events.length === 0 ? typeEvents : events.filter(e => typeEvents.includes(e));
    }

    if (query.resolvers && query.resolvers.length > 0) {
      const resolverEvents = query.resolvers.flatMap(resolver => 
        this.eventIndex.byResolver.get(resolver) || []
      );
      events = events.length === 0 ? resolverEvents : events.filter(e => resolverEvents.includes(e));
    }

    if (query.chainIds && query.chainIds.length > 0) {
      const chainEvents = query.chainIds.flatMap(chainId => 
        this.eventIndex.byChainId.get(chainId) || []
      );
      events = events.length === 0 ? chainEvents : events.filter(e => chainEvents.includes(e));
    }

    // If no specific filters, return all events
    if (events.length === 0) {
      events = this.memoryEvents;
    }

    return events;
  }

  private queryFromMemory(query: EventQuery): EventMessage[] {
    return this.memoryEvents.filter(event => {
      // Apply filters
      if (query.eventTypes && !query.eventTypes.includes(event.eventType)) {
        return false;
      }
      
      if (query.orderHashes && event.metadata.orderHash && 
          !query.orderHashes.includes(event.metadata.orderHash)) {
        return false;
      }
      
      if (query.resolvers && event.metadata.resolver && 
          !query.resolvers.includes(event.metadata.resolver)) {
        return false;
      }
      
      if (query.chainIds && event.metadata.chainId && 
          !query.chainIds.includes(event.metadata.chainId)) {
        return false;
      }
      
      if (query.timeRange && 
          (event.timestamp < query.timeRange.start || event.timestamp > query.timeRange.end)) {
        return false;
      }
      
      return true;
    });
  }

  private applyFilters(events: EventMessage[], query: EventQuery): EventMessage[] {
    // Additional filtering if needed
    return events;
  }

  private sortEvents(events: EventMessage[], sortBy: string, sortOrder: 'asc' | 'desc'): EventMessage[] {
    return events.sort((a, b) => {
      let aValue: any;
      let bValue: any;

      switch (sortBy) {
        case 'timestamp':
          aValue = a.timestamp;
          bValue = b.timestamp;
          break;
        case 'eventType':
          aValue = a.eventType;
          bValue = b.eventType;
          break;
        case 'orderHash':
          aValue = a.metadata.orderHash || '';
          bValue = b.metadata.orderHash || '';
          break;
        default:
          aValue = a.timestamp;
          bValue = b.timestamp;
      }

      const comparison = aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
      return sortOrder === 'asc' ? comparison : -comparison;
    });
  }

  private updateIndex(event: EventMessage): void {
    // Update byEventType
    if (!this.eventIndex.byEventType.has(event.eventType)) {
      this.eventIndex.byEventType.set(event.eventType, []);
    }
    this.eventIndex.byEventType.get(event.eventType)!.push(event);

    // Update byOrderHash
    if (event.metadata.orderHash) {
      if (!this.eventIndex.byOrderHash.has(event.metadata.orderHash)) {
        this.eventIndex.byOrderHash.set(event.metadata.orderHash, []);
      }
      this.eventIndex.byOrderHash.get(event.metadata.orderHash)!.push(event);
    }

    // Update byResolver
    if (event.metadata.resolver) {
      if (!this.eventIndex.byResolver.has(event.metadata.resolver)) {
        this.eventIndex.byResolver.set(event.metadata.resolver, []);
      }
      this.eventIndex.byResolver.get(event.metadata.resolver)!.push(event);
    }

    // Update byChainId
    if (event.metadata.chainId) {
      if (!this.eventIndex.byChainId.has(event.metadata.chainId)) {
        this.eventIndex.byChainId.set(event.metadata.chainId, []);
      }
      this.eventIndex.byChainId.get(event.metadata.chainId)!.push(event);
    }

    // Update byTimeRange (group by day)
    const dayKey = new Date(event.timestamp).toISOString().slice(0, 10);
    if (!this.eventIndex.byTimeRange.has(dayKey)) {
      this.eventIndex.byTimeRange.set(dayKey, []);
    }
    this.eventIndex.byTimeRange.get(dayKey)!.push(event);
  }

  private updateStatistics(event: EventMessage): void {
    this.statistics.totalEvents++;
    this.statistics.eventsByType[event.eventType] = (this.statistics.eventsByType[event.eventType] || 0) + 1;
    
    if (event.metadata.chainId) {
      this.statistics.eventsByChain[event.metadata.chainId] = (this.statistics.eventsByChain[event.metadata.chainId] || 0) + 1;
    }
    
    if (event.metadata.resolver) {
      this.statistics.eventsByResolver[event.metadata.resolver] = (this.statistics.eventsByResolver[event.metadata.resolver] || 0) + 1;
    }

    // Update time range counters
    const now = Date.now();
    const eventAge = now - event.timestamp;
    
    if (eventAge <= 60 * 60 * 1000) this.statistics.timeRanges.last1Hour++;
    if (eventAge <= 24 * 60 * 60 * 1000) this.statistics.timeRanges.last24Hours++;
    if (eventAge <= 7 * 24 * 60 * 60 * 1000) this.statistics.timeRanges.last7Days++;
    if (eventAge <= 30 * 24 * 60 * 60 * 1000) this.statistics.timeRanges.last30Days++;
  }

  private rebuildIndex(): void {
    // Clear existing index
    this.eventIndex = {
      byOrderHash: new Map(),
      byResolver: new Map(),
      byChainId: new Map(),
      byEventType: new Map(),
      byTimeRange: new Map()
    };

    // Rebuild from memory events
    this.memoryEvents.forEach(event => this.updateIndex(event));
  }

  private initializeStatistics(): EventStatistics {
    const eventTypes = Object.values(EventType).reduce((acc, type) => {
      acc[type] = 0;
      return acc;
    }, {} as Record<EventType, number>);

    return {
      totalEvents: 0,
      eventsByType: eventTypes,
      eventsByChain: {},
      eventsByResolver: {},
      timeRanges: {
        last1Hour: 0,
        last24Hours: 0,
        last7Days: 0,
        last30Days: 0
      },
      averageEventsPerMinute: 0,
      peakEventsPerMinute: 0,
      mostActiveOrders: []
    };
  }

  private persistOldestEvents(): void {
    const eventsToPersist = this.memoryEvents.splice(0, Math.floor(this.config.maxMemoryEvents / 2));
    
    // Save to disk (simplified implementation)
    const filename = `events-${Date.now()}.json`;
    const filepath = join(this.config.storageDirectory, filename);
    
    writeFileSync(filepath, JSON.stringify(eventsToPersist, null, 2));
    log.debug({ eventCount: eventsToPersist.length, filename }, 'events persisted to disk');
  }

  private loadPersistedEvents(): void {
    // Load recent events from disk (simplified implementation)
    // In real implementation, would load most recent persisted events
    log.debug('loading persisted events');
  }

  private ensureStorageDirectory(): void {
    if (!existsSync(this.config.storageDirectory)) {
      mkdirSync(this.config.storageDirectory, { recursive: true });
    }
  }

  private ensureDirectory(path: string): void {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  }

  private calculateChecksum(events: EventMessage[]): string {
    // Simple checksum calculation
    return events.reduce((sum, event) => sum + event.timestamp, 0).toString(16);
  }

  private generateId(): string {
    return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
  }
}

export default EventHistoryManager; 