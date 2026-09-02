/**
 * @fileoverview Uptime Monitoring System for WaffleFinance
 * @description Comprehensive health monitoring, metrics collection, and alerting
 */

import { EventEmitter } from 'events';
import { getCurrentTimestamp } from './utils.js';
import { getLogger } from '../logger.js';

const log = getLogger().child({ service: 'monitoring' });

export interface HealthMetrics {
  uptime: number;
  timestamp: number;
  version: string;
  environment: string;
  services: ServiceHealth[];
  system: SystemMetrics;
  network: NetworkMetrics;
  database: DatabaseMetrics;
  performance: PerformanceMetrics;
}

export interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  uptime: number;
  lastCheck: number;
  responseTime: number;
  errorRate: number;
  details?: Record<string, any>;
}

export interface SystemMetrics {
  memoryUsage: {
    used: number;
    total: number;
    percentage: number;
  };
  cpuUsage: number;
  diskUsage: {
    used: number;
    total: number;
    percentage: number;
  };
  loadAverage: number[];
}

export interface NetworkMetrics {
  ethereum: {
    blockNumber: number;
    gasPrice: string;
    networkId: number;
    connected: boolean;
    responseTime: number;
  };
  stellar: {
    ledgerNumber: number;
    networkId: string;
    connected: boolean;
    responseTime: number;
  };
}

export interface DatabaseMetrics {
  connectionCount: number;
  activeTransactions: number;
  queryTime: number;
  errorRate: number;
}

export interface PerformanceMetrics {
  ordersProcessed: number;
  averageOrderTime: number;
  successRate: number;
  throughput: number;
  latency: {
    p50: number;
    p95: number;
    p99: number;
  };
}

export class UptimeMonitor extends EventEmitter {
  private startTime: number;
  private metrics: HealthMetrics;
  private services: Map<string, ServiceHealth>;
  private isRunning: boolean = false;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private alertThresholds: AlertThresholds;

  constructor() {
    super();
    this.startTime = getCurrentTimestamp();
    this.services = new Map();
    this.alertThresholds = {
      responseTime: 5000, // 5 seconds
      errorRate: 0.05, // 5%
      memoryUsage: 0.85, // 85%
      diskUsage: 0.80, // 80%
      cpuUsage: 0.80, // 80%
    };
    this.metrics = this.initializeMetrics();
  }

  private initializeMetrics(): HealthMetrics {
    return {
      uptime: 0,
      timestamp: getCurrentTimestamp(),
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      services: [],
      system: {
        memoryUsage: { used: 0, total: 0, percentage: 0 },
        cpuUsage: 0,
        diskUsage: { used: 0, total: 0, percentage: 0 },
        loadAverage: [0, 0, 0],
      },
      network: {
        ethereum: {
          blockNumber: 0,
          gasPrice: '0',
          networkId: 0,
          connected: false,
          responseTime: 0,
        },
        stellar: {
          ledgerNumber: 0,
          networkId: '',
          connected: false,
          responseTime: 0,
        },
      },
      database: {
        connectionCount: 0,
        activeTransactions: 0,
        queryTime: 0,
        errorRate: 0,
      },
      performance: {
        ordersProcessed: 0,
        averageOrderTime: 0,
        successRate: 0,
        throughput: 0,
        latency: { p50: 0, p95: 0, p99: 0 },
      },
    };
  }

  /**
   * Start monitoring system
   */
  startMonitoring(interval: number = 30000): void {
    if (this.isRunning) {
      log.warn('[monitoring] already running');
      return;
    }

    this.isRunning = true;
    this.monitoringInterval = setInterval(() => {
      this.collectMetrics();
    }, interval);

    log.info({ intervalMs: interval }, '[monitoring] uptime monitoring started');
    this.emit('monitoring:started');
  }

  /**
   * Stop monitoring system
   */
  stopMonitoring(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    log.info('[monitoring] uptime monitoring stopped');
    this.emit('monitoring:stopped');
  }

  /**
   * Register a service for monitoring
   */
  registerService(name: string, healthCheckFn: () => Promise<Partial<ServiceHealth>>): void {
    const service: ServiceHealth = {
      name,
      status: 'unknown',
      uptime: 0,
      lastCheck: 0,
      responseTime: 0,
      errorRate: 0,
    };

    this.services.set(name, service);
    log.debug({ serviceName: name }, '[monitoring] service registered');
  }

  /**
   * Collect all metrics
   */
  private async collectMetrics(): Promise<void> {
    try {
      const now = getCurrentTimestamp();
      this.metrics.uptime = now - this.startTime;
      this.metrics.timestamp = now;

      // Collect system metrics
      await this.collectSystemMetrics();

      // Collect network metrics
      await this.collectNetworkMetrics();

      // Collect service metrics
      await this.collectServiceMetrics();

      // Check for alerts
      this.checkAlerts();

      // Emit metrics update
      this.emit('metrics:updated', this.metrics);
    } catch (error) {
      log.error({ err: error }, '[monitoring] failed to collect metrics');
      this.emit('metrics:error', error);
    }
  }

  /**
   * Collect system metrics
   */
  private async collectSystemMetrics(): Promise<void> {
    const memUsage = process.memoryUsage();
    
    // Temporarily disable OS metrics to avoid require issues
    this.metrics.system = {
      memoryUsage: {
        used: memUsage.heapUsed,
        total: memUsage.heapTotal,
        percentage: 0,
      },
      cpuUsage: 0,
      diskUsage: {
        used: 0,
        total: 0,
        percentage: 0,
      },
      loadAverage: [0, 0, 0],
    };
  }

  /**
   * Collect network metrics
   */
  private async collectNetworkMetrics(): Promise<void> {
    // Ethereum metrics
    try {
      const ethStart = Date.now();
      // Mock ethereum metrics - replace with actual RPC calls
      this.metrics.network.ethereum = {
        blockNumber: Math.floor(Math.random() * 1000000),
        gasPrice: '20000000000',
        networkId: 1,
        connected: true,
        responseTime: Date.now() - ethStart,
      };
    } catch (error) {
      this.metrics.network.ethereum.connected = false;
      this.metrics.network.ethereum.responseTime = 0;
    }

    // Stellar metrics
    try {
      const stellarStart = Date.now();
      // Mock stellar metrics - replace with actual Horizon API calls
      this.metrics.network.stellar = {
        ledgerNumber: Math.floor(Math.random() * 1000000),
        networkId: 'testnet',
        connected: true,
        responseTime: Date.now() - stellarStart,
      };
    } catch (error) {
      this.metrics.network.stellar.connected = false;
      this.metrics.network.stellar.responseTime = 0;
    }
  }

  /**
   * Collect service metrics
   */
  private async collectServiceMetrics(): Promise<void> {
    const serviceList: ServiceHealth[] = [];

    for (const [name, service] of this.services) {
      try {
        const start = Date.now();
        // Mock service health check
        const health = await this.performHealthCheck(name);
        const responseTime = Date.now() - start;

        const updatedService: ServiceHealth = {
          ...service,
          ...health,
          responseTime,
          lastCheck: getCurrentTimestamp(),
        };

        this.services.set(name, updatedService);
        serviceList.push(updatedService);
      } catch (error) {
        const failedService: ServiceHealth = {
          ...service,
          status: 'unhealthy',
          lastCheck: getCurrentTimestamp(),
          details: { error: error instanceof Error ? error.message : 'Unknown error' },
        };

        this.services.set(name, failedService);
        serviceList.push(failedService);
      }
    }

    this.metrics.services = serviceList;
  }

  /**
   * Perform health check for a service
   */
  private async performHealthCheck(serviceName: string): Promise<Partial<ServiceHealth>> {
    // Mock health check - replace with actual implementation
    const isHealthy = Math.random() > 0.1; // 90% healthy
    
    return {
      status: isHealthy ? 'healthy' : 'degraded',
      uptime: Math.random() * 100,
      errorRate: Math.random() * 0.1,
    };
  }

  /**
   * Check for alerts
   */
  private checkAlerts(): void {
    const alerts: Alert[] = [];

    // System alerts
    if (this.metrics.system.memoryUsage.percentage > this.alertThresholds.memoryUsage) {
      alerts.push({
        type: 'system',
        severity: 'warning',
        message: `High memory usage: ${(this.metrics.system.memoryUsage.percentage * 100).toFixed(1)}%`,
        timestamp: getCurrentTimestamp(),
      });
    }

    // Network alerts
    if (!this.metrics.network.ethereum.connected) {
      alerts.push({
        type: 'network',
        severity: 'critical',
        message: 'Ethereum network disconnected',
        timestamp: getCurrentTimestamp(),
      });
    }

    if (!this.metrics.network.stellar.connected) {
      alerts.push({
        type: 'network',
        severity: 'critical',
        message: 'Stellar network disconnected',
        timestamp: getCurrentTimestamp(),
      });
    }

    // Service alerts
    for (const service of this.metrics.services) {
      if (service.status === 'unhealthy') {
        alerts.push({
          type: 'service',
          severity: 'critical',
          message: `Service ${service.name} is unhealthy`,
          timestamp: getCurrentTimestamp(),
        });
      }
    }

    if (alerts.length > 0) {
      this.emit('alerts:triggered', alerts);
    }
  }

  /**
   * Get current metrics
   */
  getMetrics(): HealthMetrics {
    return { ...this.metrics };
  }

  /**
   * Get service health
   */
  getServiceHealth(serviceName: string): ServiceHealth | undefined {
    return this.services.get(serviceName);
  }

  /**
   * Get system status
   */
  getSystemStatus(): 'healthy' | 'degraded' | 'unhealthy' {
    const unhealthyServices = this.metrics.services.filter(s => s.status === 'unhealthy').length;
    const totalServices = this.metrics.services.length;

    if (unhealthyServices === 0) {
      return 'healthy';
    } else if (unhealthyServices < totalServices * 0.5) {
      return 'degraded';
    } else {
      return 'unhealthy';
    }
  }
}

interface AlertThresholds {
  responseTime: number;
  errorRate: number;
  memoryUsage: number;
  diskUsage: number;
  cpuUsage: number;
}

interface Alert {
  type: 'system' | 'network' | 'service' | 'performance';
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  timestamp: number;
}

// Singleton instance
let monitorInstance: UptimeMonitor | null = null;

export const getMonitor = (): UptimeMonitor => {
  if (!monitorInstance) {
    monitorInstance = new UptimeMonitor();
  }
  return monitorInstance;
};

export default UptimeMonitor; 