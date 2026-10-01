/**
 * @fileoverview RPC methods for 1inch Fusion+ WebSocket API
 * @description 1inch compliant RPC methods for real-time communication
 */

import { OrdersService } from './orders.js';
import ProgressiveFillManager from './partial-fills.js';
import FusionEventManager, { EventType } from './event-handlers.js';
import { getLogger } from '../logger.js';

const log = getLogger().child({ component: 'rpc-methods' });

// RPC method names (1inch compliant)
export enum RpcMethod {
  Ping = 'ping',
  GetAllowedMethods = 'getAllowedMethods',
  GetActiveOrders = 'getActiveOrders',
  GetSecrets = 'getSecrets',
  GetEventHistory = 'getEventHistory',
  GetStatistics = 'getStatistics',
  
  // WebSocket subscription methods
  Subscribe = 'subscribe',
  Unsubscribe = 'unsubscribe',
  
  // Order management
  SubmitOrder = 'submitOrder',
  CancelOrder = 'cancelOrder',
  GetOrderStatus = 'getOrderStatus'
}

// RPC request/response structures
export interface RpcRequest {
  id: string;
  method: RpcMethod;
  params?: any;
  timestamp?: number;
}

export interface RpcResponse {
  id: string;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
  timestamp: number;
}

export interface RpcError {
  code: number;
  message: string;
  data?: any;
}

// Standard RPC error codes
export const RPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
  SERVER_ERROR: { code: -32000, message: 'Server error' },
  UNAUTHORIZED: { code: -32001, message: 'Unauthorized' },
  RATE_LIMITED: { code: -32002, message: 'Rate limited' }
};

// Order status for getActiveOrders
export interface ActiveOrderInfo {
  orderHash: string;
  status: 'pending' | 'active' | 'partially_filled' | 'filled' | 'cancelled' | 'expired';
  srcChainId: number;
  dstChainId: number;
  makingAmount: string;
  takingAmount: string;
  fillPercentage: number;
  remainingAmount: string;
  fragments?: {
    total: number;
    filled: number;
    ready: number;
  };
  resolver?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

// Secrets info for getSecrets
export interface SecretInfo {
  orderHash: string;
  secretIndex: number;
  secretHash: string;
  secret?: string; // Only revealed when appropriate
  fragmentIndex: number;
  status: 'pending' | 'revealed' | 'used';
  resolver?: string;
  revealedAt?: number;
}

// Subscription parameters
export interface SubscriptionParams {
  events: EventType[];
  orderHashes?: string[];

  chainIds?: number[];
  filterByUrgent?: boolean;
}

export class FusionRpcHandler {
  private ordersService: OrdersService;
  private progressiveFillManager?: ProgressiveFillManager;
  private eventManager: FusionEventManager;
  private requestCount = 0;
  private rateLimits = new Map<string, { count: number; resetTime: number }>();
  private readonly RATE_LIMIT_WINDOW = 60000; // 1 minute
  private readonly RATE_LIMIT_MAX = 100; // 100 requests per minute

  constructor(
    ordersService: OrdersService,
    eventManager: FusionEventManager,
    progressiveFillManager?: ProgressiveFillManager
  ) {
    this.ordersService = ordersService;
    this.eventManager = eventManager;
    this.progressiveFillManager = progressiveFillManager;
  }

  /**
   * Handle RPC request
   */
  async handleRpcRequest(request: RpcRequest, clientId: string): Promise<RpcResponse> {
    const startTime = Date.now();
    
    try {
      // Rate limiting
      if (!this.checkRateLimit(clientId)) {
        return this.createErrorResponse(request.id, RPC_ERRORS.RATE_LIMITED);
      }

      // Validate request
      if (!this.validateRequest(request)) {
        return this.createErrorResponse(request.id, RPC_ERRORS.INVALID_REQUEST);
      }

      // Handle method
      const result = await this.handleMethod(request, clientId);
      
      const response: RpcResponse = {
        id: request.id,
        result,
        timestamp: Date.now()
      };

      log.info({ method: request.method, durationMs: Date.now() - startTime }, 'RPC completed');
      return response;

    } catch (error) {
      log.error({ method: request.method, err: error }, 'RPC error');
      return this.createErrorResponse(
        request.id,
        RPC_ERRORS.INTERNAL_ERROR,
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  /**
   * Handle specific RPC methods
   */
  private async handleMethod(request: RpcRequest, clientId: string): Promise<any> {
    const { method, params } = request;

    switch (method) {
      case RpcMethod.Ping:
        return this.handlePing(params);

      case RpcMethod.GetAllowedMethods:
        return this.handleGetAllowedMethods();

      case RpcMethod.GetActiveOrders:
        return await this.handleGetActiveOrders(params);

      case RpcMethod.GetSecrets:
        return await this.handleGetSecrets(params);

      case RpcMethod.GetEventHistory:
        return this.handleGetEventHistory(params);

      case RpcMethod.GetStatistics:
        return this.handleGetStatistics();

      case RpcMethod.Subscribe:
        return this.handleSubscribe(params, clientId);

      case RpcMethod.Unsubscribe:
        return this.handleUnsubscribe(params, clientId);

      case RpcMethod.SubmitOrder:
        return await this.handleSubmitOrder(params);

      case RpcMethod.CancelOrder:
        return await this.handleCancelOrder(params);

      case RpcMethod.GetOrderStatus:
        return await this.handleGetOrderStatus(params);

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  /**
   * Handle ping method
   */
  private handlePing(params?: any): any {
    return {
      pong: true,
      timestamp: Date.now(),
      uptime: process.uptime() * 1000,
      version: '1.0.0',
      chainIds: [1, 137], // Ethereum, Polygon
      features: ['partial_fills', 'merkle_secrets']
    };
  }

  /**
   * Handle getAllowedMethods method
   */
  private handleGetAllowedMethods(): any {
    return {
      methods: Object.values(RpcMethod),
      version: '1.0.0',
      supportedEvents: Object.values(EventType),
      extensions: {
        partialFills: true,
  
        merkleSecrets: true,
        realTimeEvents: true
      }
    };
  }

  /**
   * Handle getActiveOrders method
   *
   * The v1 implementation returned fabricated orders with hashes like
   * `0xa1b2c3d4...`. That has been removed. Real order storage is being
   * implemented in the v2 coordinator (Phase 4); until then this endpoint
   * returns an empty result set rather than misleading data.
   */
  private async handleGetActiveOrders(_params?: any): Promise<any> {
    const orders: ActiveOrderInfo[] = [];
    return {
      orders,
      pagination: { total: 0, limit: 0, offset: 0, hasMore: false },
      metadata: { totalValue: '0', averageFillPercentage: 0, activeChains: [] },
      notice: 'Live order index is being migrated to the v2 coordinator. See ARCHITECTURE.md.'
    };
  }

  /**
   * Handle getSecrets method
   *
   * Returns the real secret-reveal state for an order. Until the v2
   * coordinator backs this with persistent storage, we explicitly refuse
   * to fabricate placeholder secrets/hashes.
   */
  private async handleGetSecrets(params?: any): Promise<any> {
    const { orderHash } = params || {};
    if (!orderHash) {
      throw new Error('orderHash is required');
    }
    const secrets: SecretInfo[] = [];
    return {
      orderHash,
      secrets,
      totalSecrets: 0,
      revealedSecrets: 0,
      notice: 'Secret tracking is being migrated to the v2 coordinator. See ARCHITECTURE.md.'
    };
  }

  /**
   * Handle getEventHistory method
   */
  private handleGetEventHistory(params?: any): any {
    const { 
      eventTypes, 
      orderHash, 
      limit = 100, 
      offset = 0, 
      since 
    } = params || {};

    const options = {
      eventTypes: eventTypes ? eventTypes.filter(type => Object.values(EventType).includes(type)) : undefined,
      orderHash,
      limit,
      offset
    };

    const events = this.eventManager.getEventHistory(options);
    
    // Apply time filter if provided
    let filteredEvents = events;
    if (since) {
      filteredEvents = events.filter(event => event.timestamp >= since);
    }

    return {
      events: filteredEvents,
      pagination: {
        total: filteredEvents.length,
        limit,
        offset,
        hasMore: offset + limit < filteredEvents.length
      }
    };
  }

  /**
   * Handle getStatistics method
   */
  private handleGetStatistics(): any {
    const stats = this.eventManager.getStatistics();
    
    return {
      ...stats,
      rpcStats: {
        totalRequests: this.requestCount,
        uptime: process.uptime() * 1000,
        memoryUsage: process.memoryUsage(),
        activeConnections: this.eventManager.getListenerCount()
      }
    };
  }

  /**
   * Handle subscribe method
   */
  private handleSubscribe(params: SubscriptionParams, clientId: string): any {
    const { events, orderHashes, chainIds, filterByUrgent } = params;

    if (!events || !Array.isArray(events)) {
      throw new Error('events array is required');
    }

    // Validate events
    const validEvents = events.filter(event => Object.values(EventType).includes(event));
    if (validEvents.length === 0) {
      throw new Error('No valid events specified');
    }

    // Add event listener
    const listenerId = this.eventManager.addEventListener({
      eventTypes: new Set(validEvents),
      filters: {
        orderHashes: orderHashes ? new Set(orderHashes) : undefined,
  
        chainIds: chainIds ? new Set(chainIds) : undefined
      },
      callback: (event) => {
        // This would send to WebSocket client
        console.log(`📡 Event for client ${clientId}:`, event.eventType);
      }
    });

    return {
      subscribed: true,
      listenerId,
      events: validEvents,
      filters: {
        orderHashes: orderHashes || [],
  
        chainIds: chainIds || []
      }
    };
  }

  /**
   * Handle unsubscribe method
   */
  private handleUnsubscribe(params: any, clientId: string): any {
    const { listenerId, events } = params;

    if (listenerId) {
      const removed = this.eventManager.removeEventListener(listenerId);
      return { unsubscribed: removed, listenerId };
    }

    // If no listenerId, this would remove all subscriptions for client
    return { unsubscribed: true, message: 'All subscriptions removed' };
  }

  /**
   * Handle submitOrder method
   *
   * The legacy implementation returned a randomly generated `orderHash`
   * that did not correspond to anything on-chain. We now reject the call
   * until the v2 coordinator wires this through `OrdersService`.
   */
  private async handleSubmitOrder(_params: any): Promise<any> {
    throw new Error('submitOrder is not available on this coordinator build. Use the v2 REST endpoint /api/orders/create.');
  }

  /**
   * Handle cancelOrder method
   */
  private async handleCancelOrder(params: any): Promise<any> {
    const { orderHash } = params;
    if (!orderHash) {
      throw new Error('orderHash is required');
    }

    // This would integrate with orders service
    return { cancelled: true, orderHash };
  }

  /**
   * Handle getOrderStatus method
   *
   * Returns the real status from `OrdersService` if available; never
   * fabricates fill percentages or fragment counts.
   */
  private async handleGetOrderStatus(params: any): Promise<any> {
    const { orderHash } = params;
    if (!orderHash) {
      throw new Error('orderHash is required');
    }
    const order = (this.ordersService as any)?.getOrder?.(orderHash);
    if (!order) {
      return {
        orderHash,
        status: 'unknown',
        notice: 'Order not found in coordinator storage. Real-time status will be available after Phase 4.',
        lastUpdate: Date.now()
      };
    }
    return {
      orderHash,
      status: order.status,
      fillPercentage: order.fillPercentage ?? 0,
      fragments: order.fragments,
      lastUpdate: order.lastUpdate ?? Date.now()
    };
  }

  /**
   * Validate RPC request
   */
  private validateRequest(request: RpcRequest): boolean {
    return !!(request.id && request.method && Object.values(RpcMethod).includes(request.method));
  }

  /**
   * Check rate limiting
   */
  private checkRateLimit(clientId: string): boolean {
    const now = Date.now();
    const clientLimit = this.rateLimits.get(clientId);

    if (!clientLimit || now > clientLimit.resetTime) {
      this.rateLimits.set(clientId, { count: 1, resetTime: now + this.RATE_LIMIT_WINDOW });
      return true;
    }

    if (clientLimit.count >= this.RATE_LIMIT_MAX) {
      return false;
    }

    clientLimit.count++;
    return true;
  }

  /**
   * Create error response
   */
  private createErrorResponse(id: string, error: RpcError, data?: any): RpcResponse {
    return {
      id,
      error: { ...error, data },
      timestamp: Date.now()
    };
  }

  /**
   * Get server statistics
   */
  getServerStats(): any {
    return {
      totalRequests: this.requestCount,
      activeRateLimits: this.rateLimits.size,
      uptime: process.uptime() * 1000,
      memoryUsage: process.memoryUsage()
    };
  }
}

export default FusionRpcHandler; 