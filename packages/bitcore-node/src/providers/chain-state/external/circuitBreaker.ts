import logger from '../../../logger';

export enum CircuitState {
  CLOSED = 'CLOSED',       // Healthy - all requests flow through
  OPEN = 'OPEN',           // Failing - requests rejected, waiting for timeout
  HALF_OPEN = 'HALF_OPEN'  // Testing - allowing probe requests to check recovery
}

export interface CircuitBreakerConfig {
  failureThreshold: number;      // Open after N consecutive failures (default: 5)
  failureRateThreshold: number;  // Or open when failure rate > X (default: 0.5 = 50%)
  minAttemptsInWindow: number;   // Min attempts before failure rate is considered (default: 10)
  successThreshold: number;      // Close after N successes in HALF_OPEN (default: 2)
  timeout: number;               // ms before OPEN -> HALF_OPEN (default: 60000)
  monitoringWindow: number;      // Rolling window for failure rate calculation (default: 300000 = 5min)
  halfOpenMaxInFlight: number;   // Max concurrent probe requests in HALF_OPEN (default: 1)
}

export const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  failureRateThreshold: 0.5,
  minAttemptsInWindow: 10,
  successThreshold: 2,
  timeout: 60000,
  monitoringWindow: 300000,
  halfOpenMaxInFlight: 1
};

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures: number = 0;
  private halfOpenSuccesses: number = 0;
  private halfOpenInFlight: number = 0;
  private lastFailureTime: number = 0;
  private recentAttempts: Array<{ success: boolean; timestamp: number }> = [];
  private config: CircuitBreakerConfig;
  /** Composite key for uniqueness: chain:network:providerName */
  readonly key: string;

  constructor(
    private providerName: string,
    config?: Partial<CircuitBreakerConfig>,
    keyParts?: { chain: string; network: string }
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.key = keyParts
      ? `${keyParts.chain}:${keyParts.network}:${providerName}`
      : providerName;
  }

  canAttempt(): boolean {
    switch (this.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN: {
        const elapsed = Date.now() - this.lastFailureTime;
        if (elapsed >= this.config.timeout) {
          this.state = CircuitState.HALF_OPEN;
          this.halfOpenSuccesses = 0;
          this.halfOpenInFlight = 0;
          logger.info(`CircuitBreaker [${this.key}]: OPEN -> HALF_OPEN (timeout elapsed)`);
          return true;
        }
        return false;
      }

      case CircuitState.HALF_OPEN:
        // Limit concurrent probes in HALF_OPEN to prevent thundering herd.
        // IMPORTANT: Callers MUST call recordSuccess() or recordFailure() after each
        // granted attempt to release the in-flight permit. If neither is called
        // (e.g., early validation throw), use releasePermit() to prevent permit leaks.
        if (this.halfOpenInFlight >= this.config.halfOpenMaxInFlight) {
          return false;
        }
        this.halfOpenInFlight++;
        return true;

      default:
        return false;
    }
  }

  recordSuccess(): void {
    this.recentAttempts.push({ success: true, timestamp: Date.now() });
    this.cleanOldAttempts();

    switch (this.state) {
      case CircuitState.HALF_OPEN:
        this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
        this.halfOpenSuccesses++;
        if (this.halfOpenSuccesses >= this.config.successThreshold) {
          this.state = CircuitState.CLOSED;
          this.consecutiveFailures = 0;
          this.halfOpenSuccesses = 0;
          this.halfOpenInFlight = 0;
          logger.info(`CircuitBreaker [${this.key}]: HALF_OPEN -> CLOSED (recovered)`);
        }
        break;

      case CircuitState.CLOSED:
        this.consecutiveFailures = 0;
        break;
    }
  }

  recordFailure(error: Error): void {
    this.lastFailureTime = Date.now();
    this.recentAttempts.push({ success: false, timestamp: Date.now() });
    this.cleanOldAttempts();

    switch (this.state) {
      case CircuitState.HALF_OPEN:
        this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
        this.state = CircuitState.OPEN;
        this.halfOpenSuccesses = 0;
        logger.warn(`CircuitBreaker [${this.key}]: HALF_OPEN -> OPEN (probe failed: ${error.message})`);
        break;

      case CircuitState.CLOSED: {
        this.consecutiveFailures++;
        const failureRate = this.getFailureRate();
        // Only consider failure rate if we have enough samples to be statistically meaningful
        const rateBasedOpen =
          this.recentAttempts.length >= this.config.minAttemptsInWindow &&
          failureRate >= this.config.failureRateThreshold;
        const shouldOpen =
          this.consecutiveFailures >= this.config.failureThreshold || rateBasedOpen;

        if (shouldOpen) {
          this.state = CircuitState.OPEN;
          logger.error(
            `CircuitBreaker [${this.key}]: CLOSED -> OPEN ` +
            `(failures: ${this.consecutiveFailures}, rate: ${(failureRate * 100).toFixed(1)}%, error: ${error.message})`
          );
          this.consecutiveFailures = 0;
        }
        break;
      }
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  /**
   * Release a HALF_OPEN in-flight permit without recording success or failure.
   * Use this when a granted attempt cannot complete (e.g., validation error before
   * the actual provider call) to prevent permit leaks.
   */
  releasePermit(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    }
  }

  getMetrics(): CircuitMetrics {
    this.cleanOldAttempts();
    return {
      state: this.state,
      failureRate: this.getFailureRate(),
      recentAttempts: this.recentAttempts.length,
      consecutiveFailures: this.consecutiveFailures,
      halfOpenSuccesses: this.halfOpenSuccesses,
      lastFailureTime: this.lastFailureTime ? new Date(this.lastFailureTime) : undefined
    };
  }

  private getFailureRate(): number {
    if (this.recentAttempts.length === 0) return 0;
    const failures = this.recentAttempts.filter(a => !a.success).length;
    return failures / this.recentAttempts.length;
  }

  private cleanOldAttempts(): void {
    const cutoff = Date.now() - this.config.monitoringWindow;
    this.recentAttempts = this.recentAttempts.filter(a => a.timestamp > cutoff);
  }
}

export interface CircuitMetrics {
  state: CircuitState;
  failureRate: number;
  recentAttempts: number;
  consecutiveFailures: number;
  halfOpenSuccesses: number;
  lastFailureTime?: Date;
}
