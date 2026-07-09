/**
 * @fileoverview Event handlers for 1inch Fusion+ partial fills
 * @description Real-time event processing and notifications
 */

import { EventEmitter } from 'events';
import { OrdersService } from './orders.js';
import ProgressiveFillManager from './partial-fills.js';
import { sanitizeForLog } from '../utils/sanitize-for-log.js';

// 1inch Fusion+ compliant event types
export enum EventType {
  OrderCreated = 'order_created',
  OrderInvalid = 'order_invalid', 
  OrderBalanceChange = 'order_balance_change',
  OrderAllowanceChange = 'order_allowance_change',
  OrderFilled = 'order_filled',
  OrderFilledPartially = 'order_filled_partially',
  OrderCancelled = 'order_cancelled',
  SecretShared = 'secret_shared',
  
  // Additional events for better tracking
  ProgressUpdate = 'progress_update',
  RecommendationGenerated = 'recommendation_generated',
  FragmentReady = 'fragment_ready',
  
  // Recovery events
  Recovery = 'recovery'
}

// Event data structures (1inch compliant)
export interface OrderCreatedEventData {
  srcChainId: number;
  dstChainId: number;
  orderHash: string;
  order: any;
  extension: string;
  signature: string;
  isMakerContract: boolean;
  quoteId: string;
  merkleLeaves?: string[];
  secretHashes?: string[];
  fragmentsCount?: number;
  allowPartialFills: boolean;
  allowMultipleFills: boolean;
}

export interface OrderFilledEventData {
  orderHash: string;
  fillAmount: string;
  resolver: string;
  txHash?: string;
  gasUsed?: string;
  effectivePrice: string;
  timestamp: number;
}

export interface OrderFilledPartiallyEventData {
  orderHash: string;
  fragmentIndex: number;
  fillAmount: string;
  remainingAmount: string;
  resolver: string;
  fillPercentage: number;
  txHash?: string;
  gasUsed?: string;
  effectivePrice: string;
  nextFragmentReady: boolean;
  estimatedCompletion: number;
  timestamp: number;
}

export interface OrderCancelledEventData {
  orderHash: string;
  reason: string;
  cancelledBy: string;
  refundAmount?: string;
  timestamp: number;
}

export interface SecretSharedEventData {
  orderHash: string;
  secretIndex: number;
  secret: string;
  resolver: string;
  fragmentIndex: number;
  unlockAmount: string;
  timestamp: number;
}

export interface ProgressUpdateEventData {
  orderHash: string;
  previousPercentage: number;
  currentPercentage: number;
  fragmentsFilled: number;
  totalFragments: number;
  estimatedCompletion: number;
  averageGasPrice: string;
  totalGasCost: string;
}

// Event message structure
export interface EventMessage {
  eventId: string;
  eventType: EventType;
  timestamp: number;
  data: any;
  metadata: {
    orderHash?: string;
    resolver?: string;
    chainId?: number;
    urgent?: boolean;
    recoveryId?: string;
    recoveryType?: string;
    recoveryStatus?: string;
    error?: string;
    type?: string;
    status?: string;
    timestamp?: number;
  };
}

// Event listener interface
export interface EventListener {
  id: string;
  eventTypes: Set<EventType>;
  filters: {
    orderHashes?: Set<string>;
    resolvers?: Set<string>;
    chainIds?: Set<number>;
  };
  callback: (event: EventMessage) => void;
  lastNotified: number;
}

export class FusionEventManager extends EventEmitter {
  private eventListeners: Map<string, EventListener> = new Map();
  private eventHistory: EventMessage[] = [];
  private processedEventKeys: Set<string> = new Set();
  private readonly MAX_HISTORY_SIZE = 500;
  private ordersService: OrdersService;
  private progressiveFillManager?: ProgressiveFillManager;

  constructor(ordersService: OrdersService) {
    super();
    this.ordersService = ordersService;
    this.setupOrderServiceListeners();
  }

  /**
   * Set progressive fill manager for advanced events
   */
  setProgressiveFillManager(manager: ProgressiveFillManager): void {
    this.progressiveFillManager = manager;
    this.setupProgressiveFillListeners();
  }

  /**
   * Setup listeners for orders service events
   */
  private setupOrderServiceListeners(): void {
    // Note: This assumes OrdersService is also an EventEmitter
    // In real implementation, we'd need to modify OrdersService to emit events
    
    this.on('orderSubmitted', (orderData) => {
      this.emitEvent(EventType.OrderCreated, orderData, {
        orderHash: orderData.orderHash,
        chainId: orderData.srcChainId
      });
    });

    this.on('orderCompleted', (orderData) => {
      this.emitEvent(EventType.OrderFilled, {
        orderHash: orderData.orderHash,
        fillAmount: orderData.fillAmount,
        resolver: orderData.resolver,
        effectivePrice: orderData.effectivePrice,
        timestamp: Date.now()
      }, {
        orderHash: orderData.orderHash,
        resolver: orderData.resolver
      });
    });

    this.on('orderCancelled', (orderData) => {
      this.emitEvent(EventType.OrderCancelled, {
        orderHash: orderData.orderHash,
        reason: orderData.reason,
        cancelledBy: orderData.cancelledBy,
        timestamp: Date.now()
      }, {
        orderHash: orderData.orderHash
      });
    });
  }

  /**
   * Setup listeners for progressive fill manager events
   */
  private setupProgressiveFillListeners(): void {
    if (!this.progressiveFillManager) return;

    this.progressiveFillManager.on('orderCreated', (data) => {
      this.emitEvent(EventType.OrderCreated, {
        srcChainId: data.order.srcChainId,
        dstChainId: data.order.dstChainId,
        orderHash: data.orderId,
        order: data.order,
        extension: data.order.extension || '0x',
        signature: '0x', // Will be provided by client
        isMakerContract: false,
        quoteId: data.order.quoteId || '',
        merkleLeaves: data.fragments.map(f => f.secretHash),
        secretHashes: data.fragments.map(f => f.secretHash),
        fragmentsCount: data.fragments.length,
        allowPartialFills: data.order.allowPartialFills,
        allowMultipleFills: data.order.allowMultipleFills
      }, {
        orderHash: data.orderId,
        chainId: data.order.srcChainId
      });
    });

    this.progressiveFillManager.on('partialFillExecuted', (data) => {
      this.emitEvent(EventType.OrderFilledPartially, {
        orderHash: data.orderId,
        fragmentIndex: data.fillExecution.fragmentIndex,
        fillAmount: data.fillExecution.fillAmount,
        remainingAmount: data.progress.remainingAmount,
        resolver: data.fillExecution.resolver,
        fillPercentage: data.progress.fillPercentage,
        effectivePrice: data.fillExecution.auctionPrice,
        nextFragmentReady: data.progress.fillPercentage < 100,
        estimatedCompletion: data.progress.estimatedCompletion,
        timestamp: Date.now()
      }, {
        orderHash: data.orderId,
        resolver: data.fillExecution.resolver,
        urgent: data.progress.fillPercentage > 80
      });

      // Also emit progress update
      this.emitEvent(EventType.ProgressUpdate, {
        orderHash: data.orderId,
        previousPercentage: Math.max(0, data.progress.fillPercentage - 20),
        currentPercentage: data.progress.fillPercentage,
        fragmentsFilled: data.progress.fragmentsFilled,
        totalFragments: data.progress.totalFragments,
        estimatedCompletion: data.progress.estimatedCompletion,
        averageGasPrice: data.progress.averageGasPrice,
        totalGasCost: data.progress.totalGasCost
      }, {
        orderHash: data.orderId
      });
    });

    this.progressiveFillManager.on('orderCompleted', (data) => {
      this.emitEvent(EventType.OrderFilled, {
        orderHash: data.orderId,
        fillAmount: data.finalProgress.totalAmount,
        resolver: 'multiple', // Multiple resolvers for partial fills
        effectivePrice: data.finalProgress.currentAuctionPrice,
        timestamp: Date.now()
      }, {
        orderHash: data.orderId,
        urgent: true
      });
    });
  }

  /**
   * Register event listener
   */
  addEventListener(listener: Omit<EventListener, 'id' | 'lastNotified'>): string {
    const id = this.generateId();
    const fullListener: EventListener = {
      ...listener,
      id,
      lastNotified: Date.now()
    };

    this.eventListeners.set(id, fullListener);
    console.log(`📡 Event listener registered: ${id} for ${Array.from(listener.eventTypes).join(', ')}`);
    return id;
  }

  /**
   * Remove event listener
   */
  removeEventListener(id: string): boolean {
    const removed = this.eventListeners.delete(id);
    if (removed) {
      console.log(`📡 Event listener removed: ${id}`);
    }
    return removed;
  }

  /**
   * Emit event to all matching listeners
   */
  emitEvent(eventType: EventType, data: any, metadata: EventMessage['metadata'] = {}): void {
    // Generate idempotency key for deduplication
    let idempotencyKey = '';
    if (metadata.orderHash) {
      const uniqueId = data.txHash || (data.fragmentIndex !== undefined ? data.fragmentIndex.toString() : null) || JSON.stringify(data);
      idempotencyKey = `${eventType}:${metadata.orderHash}:${uniqueId}`;
    } else {
      idempotencyKey = `${eventType}:${data.txHash || JSON.stringify(data)}`;
    }

    if (this.processedEventKeys.has(idempotencyKey)) {
      const hashTag = metadata.orderHash ? ` orderHash=${metadata.orderHash}` : '';
      console.log(`📡${hashTag} Duplicate event ignored: ${eventType}`);
      return;
    }
    
    this.processedEventKeys.add(idempotencyKey);
    if (this.processedEventKeys.size > 2000) {
      const iterator = this.processedEventKeys.values();
      if (iterator.next().value) {
        this.processedEventKeys.delete(iterator.next().value!);
      }
    }

    const eventMessage: EventMessage = {
      eventId: this.generateId(),
      eventType,
      timestamp: Date.now(),
      data,
      metadata
    };

    // Add to history
    this.eventHistory.push(eventMessage);
    if (this.eventHistory.length > this.MAX_HISTORY_SIZE) {
      this.eventHistory.shift();
    }

    // Notify matching listeners
    let notifiedCount = 0;
    this.eventListeners.forEach(listener => {
      if (this.shouldNotifyListener(listener, eventMessage)) {
        try {
          listener.callback(eventMessage);
          listener.lastNotified = Date.now();
          notifiedCount++;
        } catch (error) {
          const hashTag = eventMessage.metadata.orderHash ? ` orderHash=${eventMessage.metadata.orderHash}` : '';
          console.error(`❌${hashTag} Error notifying listener ${listener.id}:`, sanitizeForLog(error));
        }
      }
    });

    const hashTag = metadata.orderHash ? ` orderHash=${metadata.orderHash}` : '';
    console.log(`📡${hashTag} Event ${eventType} broadcasted to ${notifiedCount} listeners`);

    // Also emit through EventEmitter for internal use
    this.emit(eventType, eventMessage);
    this.emit('any', eventMessage);
  }

  /**
   * Check if listener should be notified
   */
  private shouldNotifyListener(listener: EventListener, event: EventMessage): boolean {
    // Check event type subscription
    if (!listener.eventTypes.has(event.eventType)) {
      return false;
    }

    // Check order filter
    if (listener.filters.orderHashes?.size && event.metadata.orderHash && 
        !listener.filters.orderHashes.has(event.metadata.orderHash)) {
      return false;
    }

    // Check resolver filter
    if (listener.filters.resolvers?.size && event.metadata.resolver && 
        !listener.filters.resolvers.has(event.metadata.resolver)) {
      return false;
    }

    // Check chain filter
    if (listener.filters.chainIds?.size && event.metadata.chainId && 
        !listener.filters.chainIds.has(event.metadata.chainId)) {
      return false;
    }

    return true;
  }

  /**
   * Get event history
   */
  getEventHistory(options?: {
    eventTypes?: EventType[];
    orderHash?: string;
    limit?: number;
    offset?: number;
  }): EventMessage[] {
    let filtered = this.eventHistory;

    if (options?.eventTypes) {
      filtered = filtered.filter(event => options.eventTypes!.includes(event.eventType));
    }

    if (options?.orderHash) {
      filtered = filtered.filter(event => event.metadata.orderHash === options.orderHash);
    }

    const offset = options?.offset || 0;
    const limit = options?.limit || 100;

    return filtered.slice(offset, offset + limit);
  }

  /**
   * Get real-time statistics
   */
  getStatistics(): {
    totalEvents: number;
    eventTypes: Record<EventType, number>;
    activeListeners: number;
    recentActivity: number;
  } {
    const eventTypes = Object.values(EventType).reduce((acc, type) => {
      acc[type] = this.eventHistory.filter(event => event.eventType === type).length;
      return acc;
    }, {} as Record<EventType, number>);

    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    const recentActivity = this.eventHistory.filter(event => event.timestamp > oneHourAgo).length;

    return {
      totalEvents: this.eventHistory.length,
      eventTypes,
      activeListeners: this.eventListeners.size,
      recentActivity
    };
  }

  /**
   * Trigger test events for development
   */
  triggerTestEvents(orderHash: string): void {
    console.log(`🧪 orderHash=${orderHash} Triggering test events for order: ${orderHash}`);

    // Order created
    this.emitEvent(EventType.OrderCreated, {
      srcChainId: 1,
      dstChainId: 137,
      orderHash,
      order: { makingAmount: '1000000000000000000' },
      extension: '0x',
      signature: '0x',
      isMakerContract: false,
      quoteId: 'test-quote',
      fragmentsCount: 5,
      allowPartialFills: true,
      allowMultipleFills: true
    }, { orderHash, chainId: 1 });

    // Partial fills
    setTimeout(() => {
      this.emitEvent(EventType.OrderFilledPartially, {
        orderHash,
        fragmentIndex: 0,
        fillAmount: '200000000000000000',
        remainingAmount: '800000000000000000',
        resolver: '0x742d35Cc6634C0532925a3b8D400e1e4dff7D88e',
        fillPercentage: 20,
        effectivePrice: '2000',
        nextFragmentReady: true,
        estimatedCompletion: Date.now() + 300000,
        timestamp: Date.now()
      }, { orderHash, resolver: '0x742d35Cc6634C0532925a3b8D400e1e4dff7D88e' });
    }, 1000);

    setTimeout(() => {
      this.emitEvent(EventType.OrderFilledPartially, {
        orderHash,
        fragmentIndex: 1,
        fillAmount: '300000000000000000',
        remainingAmount: '500000000000000000',
        resolver: '0x742d35Cc6634C0532925a3b8D400e1e4dff7D88e',
        fillPercentage: 50,
        effectivePrice: '2010',
        nextFragmentReady: true,
        estimatedCompletion: Date.now() + 150000,
        timestamp: Date.now()
      }, { orderHash, resolver: '0x742d35Cc6634C0532925a3b8D400e1e4dff7D88e' });
    }, 2000);

    // Order completed
    setTimeout(() => {
      this.emitEvent(EventType.OrderFilled, {
        orderHash,
        fillAmount: '1000000000000000000',
        resolver: 'multiple',
        effectivePrice: '2005',
        timestamp: Date.now()
      }, { orderHash, urgent: true });
    }, 3000);
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
  }

  // Public getters
  getListenerCount(): number {
    return this.eventListeners.size;
  }

  getEventHistorySize(): number {
    return this.eventHistory.length;
  }
}

export default FusionEventManager; 