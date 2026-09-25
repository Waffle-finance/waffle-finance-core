/**
 * @fileoverview Client subscription manager for 1inch Fusion+ event system
 * @description Advanced subscription management with filtering, targeting, and optimization
 */

import { EventType, EventMessage, EventListener } from './event-handlers.js';
import FusionEventManager from './event-handlers.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `registerClient` when a caller attempts to register an ID that
 * is already associated with an active client.  Callers should map this to
 * an HTTP 409 Conflict response.
 */
export class ConflictError extends Error {
  readonly code = 'CONFLICT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

// Client subscription configuration
export interface ClientSubscriptionConfig {
  maxSubscriptionsPerClient: number;
  maxEventsPerSecond: number;
  maxEventHistoryRequests: number;
  subscriptionTimeout: number;
  enablePriorityQueuing: boolean;
  enableCompression: boolean;
  enableBatching: boolean;
  batchSize: number;
  batchTimeout: number;
}

// Client information
export interface ClientInfo {
  id: string;
  connectionType: 'websocket' | 'sse' | 'polling';
  connected: boolean;
  connectedAt: number;
  lastActivity: number;
  userAgent?: string;
  ipAddress?: string;
  subscription?: ClientSubscription;
  quotaUsage: QuotaUsage;
  metadata: Record<string, any>;
}

// Client subscription details
export interface ClientSubscription {
  id: string;
  clientId: string;
  eventTypes: Set<EventType>;
  filters: SubscriptionFilters;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  createdAt: number;
  updatedAt: number;
  isActive: boolean;
  deliveryConfig: DeliveryConfig;
  statistics: SubscriptionStatistics;
}

// Subscription filters
export interface SubscriptionFilters {
  orderHashes?: Set<string>;
  resolvers?: Set<string>;
  chainIds?: Set<number>;
  eventProperties?: Record<string, any>;
  timeRange?: {
    start: number;
    end: number;
  };
  minConfidence?: number;
  maxLatency?: number;
  includeMetadata?: boolean;
  excludeTestEvents?: boolean;
}

// Delivery configuration
export interface DeliveryConfig {
  deliveryMethod: 'push' | 'pull' | 'batch';
  maxRetries: number;
  retryDelay: number;
  batchEnabled: boolean;
  batchSize: number;
  batchTimeout: number;
  compressionEnabled: boolean;
  ackRequired: boolean;
  maxBuffer: number;
}

// Quota usage tracking
export interface QuotaUsage {
  eventsReceived: number;
  subscriptionCount: number;
  historyRequests: number;
  bandwidthUsed: number;
  resetTime: number;
  quotaExceeded: boolean;
}

// Subscription statistics
export interface SubscriptionStatistics {
  totalEvents: number;
  eventsByType: Record<EventType, number>;
  averageLatency: number;
  deliverySuccess: number;
  deliveryFailures: number;
  lastDelivery: number;
  messagesQueued: number;
  bytesTransferred: number;
}

// Event delivery queue item
export interface QueuedEvent {
  id: string;
  event: EventMessage;
  clientId: string;
  priority: number;
  timestamp: number;
  retryCount: number;
  acknowledged: boolean;
}

// Subscription update request
export interface SubscriptionUpdateRequest {
  clientId: string;
  eventTypes?: EventType[];
  filters?: Partial<SubscriptionFilters>;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  deliveryConfig?: Partial<DeliveryConfig>;
}

export class ClientSubscriptionManager {
  private config: ClientSubscriptionConfig;
  private clients: Map<string, ClientInfo> = new Map();
  private subscriptions: Map<string, ClientSubscription> = new Map();
  private eventManager: FusionEventManager;
  private deliveryQueue: QueuedEvent[] = [];
  private processingQueue = false;
  private quotaResetInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  constructor(
    eventManager: FusionEventManager,
    config: Partial<ClientSubscriptionConfig> = {}
  ) {
    this.eventManager = eventManager;
    this.config = {
      maxSubscriptionsPerClient: 10,
      maxEventsPerSecond: 100,
      maxEventHistoryRequests: 50,
      subscriptionTimeout: 300000, // 5 minutes
      enablePriorityQueuing: true,
      enableCompression: true,
      enableBatching: true,
      batchSize: 50,
      batchTimeout: 5000,
      ...config
    };

    this.setupEventHandlers();
    this.startQuotaResetInterval();
    this.startCleanupInterval();
  }

  /**
   * Register new client.
   *
   * Throws a `ConflictError` when the supplied ID is already active so that
   * callers can return a meaningful error response (e.g. HTTP 409) instead of
   * silently replacing the existing connection and detaching its callbacks.
   */
  registerClient(clientInfo: Omit<ClientInfo, 'quotaUsage' | 'connectedAt' | 'lastActivity'>): string {
    if (this.clients.has(clientInfo.id)) {
      throw new ConflictError(`Client ID already registered: ${clientInfo.id}`);
    }

    const client: ClientInfo = {
      ...clientInfo,
      connected: true,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      quotaUsage: this.initializeQuotaUsage(),
      metadata: clientInfo.metadata || {}
    };

    this.clients.set(client.id, client);
    console.log(`👤 Client registered: ${client.id} (${client.connectionType})`);
    
    return client.id;
  }

  /**
   * Unregister client
   */
  unregisterClient(clientId: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) {
      console.warn(`👤 Unknown client unregistration attempted: ${clientId}`);
      return false;
    }

    // Remove client's subscription
    if (client.subscription) {
      this.cancelSubscription(clientId);
    }

    // Remove from delivery queue
    this.deliveryQueue = this.deliveryQueue.filter(item => item.clientId !== clientId);

    // Remove client
    this.clients.delete(clientId);
    console.log(`👤 Client unregistered: ${clientId}`);
    
    return true;
  }

  /**
   * Create subscription for client
   */
  createSubscription(request: SubscriptionUpdateRequest): string {
    const { clientId, eventTypes, filters, priority, deliveryConfig } = request;
    
    const client = this.clients.get(clientId);
    if (!client) {
      throw new Error(`Client not found: ${clientId}`);
    }

    // Check quota
    if (client.quotaUsage.subscriptionCount >= this.config.maxSubscriptionsPerClient) {
      throw new Error('Subscription limit exceeded');
    }

    // Reject empty event-type sets
    const resolvedEventTypes = eventTypes ?? [];
    if (resolvedEventTypes.length === 0) {
      throw new Error('At least one event type is required');
    }

    // Create subscription
    const subscriptionId = this.generateId();
    const subscription: ClientSubscription = {
      id: subscriptionId,
      clientId,
      eventTypes: new Set(resolvedEventTypes),
      filters: {
        orderHashes: filters?.orderHashes ? new Set(filters.orderHashes) : undefined,
        resolvers: filters?.resolvers ? new Set(filters.resolvers) : undefined,
        chainIds: filters?.chainIds ? new Set(filters.chainIds) : undefined,
        eventProperties: filters?.eventProperties,
        timeRange: filters?.timeRange,
        minConfidence: filters?.minConfidence,
        maxLatency: filters?.maxLatency,
        includeMetadata: filters?.includeMetadata ?? true,
        excludeTestEvents: filters?.excludeTestEvents ?? false
      },
      priority: priority || 'medium',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isActive: true,
      deliveryConfig: {
        deliveryMethod: 'push',
        maxRetries: 3,
        retryDelay: 1000,
        batchEnabled: this.config.enableBatching,
        batchSize: this.config.batchSize,
        batchTimeout: this.config.batchTimeout,
        compressionEnabled: this.config.enableCompression,
        ackRequired: false,
        maxBuffer: 1000,
        ...deliveryConfig
      },
      statistics: this.initializeSubscriptionStatistics()
    };

    // Store subscription
    this.subscriptions.set(subscriptionId, subscription);
    client.subscription = subscription;
    client.quotaUsage.subscriptionCount++;

    // Add event listener
    const listenerId = this.eventManager.addEventListener({
      eventTypes: subscription.eventTypes,
      filters: {
        orderHashes: subscription.filters.orderHashes,
        resolvers: subscription.filters.resolvers,
        chainIds: subscription.filters.chainIds
      },
      callback: (event) => this.handleEventForSubscription(subscription, event)
    });

    console.log(`📡 Subscription created: ${subscriptionId} for client ${clientId}`);
    return subscriptionId;
  }

  /**
   * Update existing subscription
   */
  updateSubscription(request: SubscriptionUpdateRequest): boolean {
    const { clientId } = request;
    const client = this.clients.get(clientId);
    
    if (!client || !client.subscription) {
      throw new Error(`Subscription not found for client: ${clientId}`);
    }

    const subscription = client.subscription;
    
    // Update subscription
    if (request.eventTypes) {
      subscription.eventTypes = new Set(request.eventTypes);
    }
    
    if (request.filters) {
      subscription.filters = {
        ...subscription.filters,
        ...request.filters,
        orderHashes: request.filters.orderHashes ? new Set(request.filters.orderHashes) : subscription.filters.orderHashes,
        resolvers: request.filters.resolvers ? new Set(request.filters.resolvers) : subscription.filters.resolvers,
        chainIds: request.filters.chainIds ? new Set(request.filters.chainIds) : subscription.filters.chainIds
      };
    }
    
    if (request.priority) {
      subscription.priority = request.priority;
    }
    
    if (request.deliveryConfig) {
      subscription.deliveryConfig = {
        ...subscription.deliveryConfig,
        ...request.deliveryConfig
      };
    }

    subscription.updatedAt = Date.now();
    
    console.log(`📡 Subscription updated: ${subscription.id}`);
    return true;
  }

  /**
   * Cancel subscription
   */
  cancelSubscription(clientId: string): boolean {
    const client = this.clients.get(clientId);
    if (!client || !client.subscription) {
      return false;
    }

    const subscription = client.subscription;
    
    // Mark as inactive
    subscription.isActive = false;
    
    // Remove from subscriptions map
    this.subscriptions.delete(subscription.id);
    
    // Remove from client
    client.subscription = undefined;
    client.quotaUsage.subscriptionCount--;
    
    // Remove from delivery queue
    this.deliveryQueue = this.deliveryQueue.filter(item => item.clientId !== clientId);
    
    console.log(`📡 Subscription cancelled: ${subscription.id}`);
    return true;
  }

  /**
   * Get subscription info
   */
  getSubscription(clientId: string): ClientSubscription | undefined {
    const client = this.clients.get(clientId);
    return client?.subscription;
  }

  /**
   * Get all subscriptions
   */
  getAllSubscriptions(): ClientSubscription[] {
    return Array.from(this.subscriptions.values());
  }

  /**
   * Get client info
   */
  getClient(clientId: string): ClientInfo | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Get all clients
   */
  getAllClients(): ClientInfo[] {
    return Array.from(this.clients.values());
  }

  /**
   * Get subscription statistics
   */
  getSubscriptionStatistics(): {
    totalClients: number;
    totalSubscriptions: number;
    activeSubscriptions: number;
    eventsByType: Record<EventType, number>;
    averageLatency: number;
    queueSize: number;
  } {
    const subscriptions = Array.from(this.subscriptions.values());
    
    const eventsByType = Object.values(EventType).reduce((acc, type) => {
      acc[type] = subscriptions.reduce((sum, sub) => sum + sub.statistics.eventsByType[type], 0);
      return acc;
    }, {} as Record<EventType, number>);

    const totalLatency = subscriptions.reduce((sum, sub) => sum + sub.statistics.averageLatency, 0);
    const averageLatency = subscriptions.length > 0 ? totalLatency / subscriptions.length : 0;

    return {
      totalClients: this.clients.size,
      totalSubscriptions: this.subscriptions.size,
      activeSubscriptions: subscriptions.filter(sub => sub.isActive).length,
      eventsByType,
      averageLatency,
      queueSize: this.deliveryQueue.length
    };
  }

  /**
   * Process delivery queue
   */
  private async processDeliveryQueue(): Promise<void> {
    if (this.processingQueue || this.deliveryQueue.length === 0) {
      return;
    }

    this.processingQueue = true;
    const startTime = Date.now();
    
    try {
      // Sort by priority and timestamp
      this.deliveryQueue.sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority; // Higher priority first
        }
        return a.timestamp - b.timestamp; // Older first
      });

      // Process items
      const processedItems: string[] = [];
      
      for (const item of this.deliveryQueue) {
        if (processedItems.length >= 100) break; // Process max 100 items per batch
        
        const delivered = await this.deliverEvent(item);
        if (delivered) {
          processedItems.push(item.id);
        }
      }

      // Remove processed items
      this.deliveryQueue = this.deliveryQueue.filter(item => !processedItems.includes(item.id));
      
      console.log(`📦 Processed ${processedItems.length} queued events in ${Date.now() - startTime}ms`);
    } finally {
      this.processingQueue = false;
    }
  }

  /**
   * Deliver event to client
   */
  private async deliverEvent(queuedEvent: QueuedEvent): Promise<boolean> {
    const client = this.clients.get(queuedEvent.clientId);
    if (!client || !client.connected) {
      return false;
    }

    const subscription = client.subscription;
    if (!subscription || !subscription.isActive) {
      return false;
    }

    try {
      // Check quota
      if (client.quotaUsage.quotaExceeded) {
        return false;
      }

      // Simulate event delivery (in real implementation, this would send via WebSocket, SSE, etc.)
      console.log(`📤 Delivering event ${queuedEvent.event.eventType} to client ${queuedEvent.clientId}`);
      
      // Update statistics
      subscription.statistics.deliverySuccess++;
      subscription.statistics.lastDelivery = Date.now();
      subscription.statistics.averageLatency = this.calculateAverageLatency(subscription, Date.now() - queuedEvent.timestamp);
      subscription.statistics.bytesTransferred += this.estimateEventSize(queuedEvent.event);
      
      // Update quota
      client.quotaUsage.eventsReceived++;
      client.quotaUsage.bandwidthUsed += this.estimateEventSize(queuedEvent.event);
      client.lastActivity = Date.now();
      
      return true;
    } catch (error) {
      console.error(`❌ Failed to deliver event to client ${queuedEvent.clientId}:`, error);
      
      // Update statistics
      subscription.statistics.deliveryFailures++;
      
      // Retry logic
      if (queuedEvent.retryCount < subscription.deliveryConfig.maxRetries) {
        queuedEvent.retryCount++;
        queuedEvent.timestamp = Date.now() + subscription.deliveryConfig.retryDelay;
        return false; // Will retry
      }
      
      return false;
    }
  }

  /**
   * Handle event for subscription
   */
  private handleEventForSubscription(subscription: ClientSubscription, event: EventMessage): void {
    // Check if subscription is active
    if (!subscription.isActive) {
      return;
    }

    // Apply additional filters
    if (!this.eventMatchesFilters(event, subscription.filters)) {
      return;
    }

    // Check quota
    const client = this.clients.get(subscription.clientId);
    if (!client || client.quotaUsage.quotaExceeded) {
      return;
    }

    // Calculate priority
    const priority = this.calculateEventPriority(event, subscription);
    
    // Add to delivery queue
    const queuedEvent: QueuedEvent = {
      id: this.generateId(),
      event,
      clientId: subscription.clientId,
      priority,
      timestamp: Date.now(),
      retryCount: 0,
      acknowledged: false
    };

    this.deliveryQueue.push(queuedEvent);
    
    // Update statistics
    subscription.statistics.totalEvents++;
    subscription.statistics.eventsByType[event.eventType] = (subscription.statistics.eventsByType[event.eventType] || 0) + 1;
    subscription.statistics.messagesQueued++;

    // Process queue
    this.processDeliveryQueue();
  }

  /**
   * Check if event matches subscription filters
   */
  private eventMatchesFilters(event: EventMessage, filters: SubscriptionFilters): boolean {
    // Time range filter
    if (filters.timeRange) {
      if (event.timestamp < filters.timeRange.start || event.timestamp > filters.timeRange.end) {
        return false;
      }
    }

    // Event properties filter
    if (filters.eventProperties) {
      for (const [key, value] of Object.entries(filters.eventProperties)) {
        if (event.data[key] !== value) {
          return false;
        }
      }
    }

    // Confidence filter
    if (filters.minConfidence && event.data.confidence < filters.minConfidence) {
      return false;
    }

    // Latency filter
    if (filters.maxLatency && (Date.now() - event.timestamp) > filters.maxLatency) {
      return false;
    }

    // Test events filter
    if (filters.excludeTestEvents && event.data.isTest) {
      return false;
    }

    return true;
  }

  /**
   * Calculate event priority
   */
  private calculateEventPriority(event: EventMessage, subscription: ClientSubscription): number {
    let priority = 0;

    // Base priority from subscription
    switch (subscription.priority) {
      case 'urgent': priority += 1000; break;
      case 'high': priority += 750; break;
      case 'medium': priority += 500; break;
      case 'low': priority += 250; break;
    }

    // Event type priority
    if (event.eventType === EventType.OrderFilledPartially) priority += 100;
    if (event.eventType === EventType.OrderFilled) priority += 200;
    if (event.eventType === EventType.OrderCancelled) priority += 150;

    // Urgency metadata
    if (event.metadata.urgent) priority += 300;

    return priority;
  }

  /**
   * Calculate average latency
   */
  private calculateAverageLatency(subscription: ClientSubscription, newLatency: number): number {
    const currentAverage = subscription.statistics.averageLatency;
    const deliveryCount = subscription.statistics.deliverySuccess;
    
    if (deliveryCount === 0) return newLatency;
    
    return ((currentAverage * (deliveryCount - 1)) + newLatency) / deliveryCount;
  }

  /**
   * Estimate event size
   */
  private estimateEventSize(event: EventMessage): number {
    return JSON.stringify(event).length;
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Clean up inactive subscriptions
    setInterval(() => {
      this.cleanupInactiveSubscriptions();
    }, 60000); // Every minute

    // Process delivery queue
    setInterval(() => {
      this.processDeliveryQueue();
    }, 1000); // Every second
  }

  /**
   * Clean up inactive subscriptions
   */
  private cleanupInactiveSubscriptions(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    this.clients.forEach((client, clientId) => {
      // Check if client is inactive
      if (now - client.lastActivity > this.config.subscriptionTimeout) {
        toRemove.push(clientId);
      }
    });

    toRemove.forEach(clientId => {
      this.unregisterClient(clientId);
    });

    if (toRemove.length > 0) {
      console.log(`🧹 Cleaned up ${toRemove.length} inactive clients`);
    }
  }

  /**
   * Start quota reset interval
   */
  private startQuotaResetInterval(): void {
    this.quotaResetInterval = setInterval(() => {
      this.resetQuotas();
    }, 60000); // Every minute
  }

  /**
   * Start cleanup interval
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupInactiveSubscriptions();
    }, 30000); // Every 30 seconds
  }

  /**
   * Reset quotas
   */
  private resetQuotas(): void {
    const now = Date.now();
    
    this.clients.forEach(client => {
      if (now >= client.quotaUsage.resetTime) {
        client.quotaUsage = this.initializeQuotaUsage();
      }
    });
  }

  /**
   * Initialize quota usage
   */
  private initializeQuotaUsage(): QuotaUsage {
    return {
      eventsReceived: 0,
      subscriptionCount: 0,
      historyRequests: 0,
      bandwidthUsed: 0,
      resetTime: Date.now() + 60000, // Reset every minute
      quotaExceeded: false
    };
  }

  /**
   * Initialize subscription statistics
   */
  private initializeSubscriptionStatistics(): SubscriptionStatistics {
    const eventsByType = Object.values(EventType).reduce((acc, type) => {
      acc[type] = 0;
      return acc;
    }, {} as Record<EventType, number>);

    return {
      totalEvents: 0,
      eventsByType,
      averageLatency: 0,
      deliverySuccess: 0,
      deliveryFailures: 0,
      lastDelivery: 0,
      messagesQueued: 0,
      bytesTransferred: 0
    };
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    if (this.quotaResetInterval) {
      clearInterval(this.quotaResetInterval);
    }
    
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.clients.clear();
    this.subscriptions.clear();
    this.deliveryQueue = [];
    
    console.log('🧹 Client subscription manager cleaned up');
  }
}

export default ClientSubscriptionManager; 