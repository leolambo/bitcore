import { expect } from 'chai';
import sinon from 'sinon';
import { CircuitBreaker, CircuitState, DEFAULT_CONFIG } from '../../src/providers/chain-state/external/circuitBreaker';

describe('CircuitBreaker', function() {
  let clock: sinon.SinonFakeTimers;

  beforeEach(function() {
    clock = sinon.useFakeTimers(Date.now());
  });

  afterEach(function() {
    clock.restore();
  });

  describe('initial state', function() {
    it('should start in CLOSED state', function() {
      const cb = new CircuitBreaker('test-provider');
      expect(cb.getState()).to.equal(CircuitState.CLOSED);
    });

    it('should allow attempts when CLOSED', function() {
      const cb = new CircuitBreaker('test-provider');
      expect(cb.canAttempt()).to.be.true;
    });

    it('should use provider name as key when no keyParts provided', function() {
      const cb = new CircuitBreaker('test-provider');
      expect(cb.key).to.equal('test-provider');
    });
  });

  describe('composite key', function() {
    it('should build composite key from chain:network:providerName', function() {
      const cb = new CircuitBreaker('moralis', undefined, { chain: 'ETH', network: 'mainnet' });
      expect(cb.key).to.equal('ETH:mainnet:moralis');
    });

    it('should use just providerName when keyParts not provided', function() {
      const cb = new CircuitBreaker('alchemy');
      expect(cb.key).to.equal('alchemy');
    });

    it('should handle custom config with keyParts', function() {
      const cb = new CircuitBreaker(
        'provider',
        { failureThreshold: 10 },
        { chain: 'MATIC', network: 'testnet' }
      );
      expect(cb.key).to.equal('MATIC:testnet:provider');
    });
  });

  describe('DEFAULT_CONFIG', function() {
    it('should export DEFAULT_CONFIG with expected values', function() {
      expect(DEFAULT_CONFIG).to.deep.equal({
        failureThreshold: 5,
        failureRateThreshold: 0.5,
        minAttemptsInWindow: 10,
        successThreshold: 2,
        timeout: 60000,
        monitoringWindow: 300000,
        halfOpenMaxInFlight: 1
      });
    });
  });

  describe('CLOSED -> OPEN via consecutive failures', function() {
    it('should open after consecutive failure threshold', function() {
      const cb = new CircuitBreaker('test', { failureThreshold: 3 });
      const err = new Error('fail');

      cb.recordFailure(err);
      expect(cb.getState()).to.equal(CircuitState.CLOSED);

      cb.recordFailure(err);
      expect(cb.getState()).to.equal(CircuitState.CLOSED);

      cb.recordFailure(err);
      expect(cb.getState()).to.equal(CircuitState.OPEN);
    });

    it('should reset consecutive failures on success in CLOSED', function() {
      const cb = new CircuitBreaker('test', { failureThreshold: 3 });
      const err = new Error('fail');

      cb.recordFailure(err);
      cb.recordFailure(err);
      expect(cb.getState()).to.equal(CircuitState.CLOSED);

      // Success resets consecutive failures
      cb.recordSuccess();
      expect(cb.getState()).to.equal(CircuitState.CLOSED);

      // Need 3 more consecutive failures to open
      cb.recordFailure(err);
      cb.recordFailure(err);
      expect(cb.getState()).to.equal(CircuitState.CLOSED);

      cb.recordFailure(err);
      expect(cb.getState()).to.equal(CircuitState.OPEN);
    });

    it('should reset consecutiveFailures to 0 after opening', function() {
      const cb = new CircuitBreaker('test', { failureThreshold: 3 });
      const err = new Error('fail');

      cb.recordFailure(err);
      cb.recordFailure(err);
      cb.recordFailure(err);
      expect(cb.getState()).to.equal(CircuitState.OPEN);

      // After opening, consecutiveFailures is reset
      const metrics = cb.getMetrics();
      expect(metrics.consecutiveFailures).to.equal(0);
    });
  });

  describe('CLOSED -> OPEN via failure rate', function() {
    it('should NOT open on failure rate when below minAttemptsInWindow', function() {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 100, // high so consecutive doesn't trigger
        failureRateThreshold: 0.5,
        minAttemptsInWindow: 10
      });
      const err = new Error('fail');

      // Only 6 failures (below minAttemptsInWindow of 10)
      for (let i = 0; i < 6; i++) {
        cb.recordFailure(err);
      }
      // 100% failure rate but only 6 attempts < 10 minAttemptsInWindow
      expect(cb.getState()).to.equal(CircuitState.CLOSED);
    });

    it('should open on failure rate when at or above minAttemptsInWindow', function() {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 100, // high so consecutive doesn't trigger
        failureRateThreshold: 0.5,
        minAttemptsInWindow: 10
      });
      const err = new Error('fail');

      // Add 5 successes and 4 failures (9 total, below threshold)
      for (let i = 0; i < 5; i++) {
        cb.recordSuccess();
      }
      for (let i = 0; i < 4; i++) {
        cb.recordFailure(err);
      }
      expect(cb.getState()).to.equal(CircuitState.CLOSED);

      // 10th attempt is a failure: 5 failures / 10 total = 0.5 = threshold
      cb.recordFailure(err);
      expect(cb.getState()).to.equal(CircuitState.OPEN);
    });
  });

  describe('OPEN state', function() {
    it('should reject attempts when OPEN', function() {
      const cb = new CircuitBreaker('test', { failureThreshold: 1 });
      cb.recordFailure(new Error('fail'));
      expect(cb.getState()).to.equal(CircuitState.OPEN);
      expect(cb.canAttempt()).to.be.false;
    });

    it('should reject attempts when OPEN and timeout not yet elapsed', function() {
      const cb = new CircuitBreaker('test', { failureThreshold: 1, timeout: 60000 });
      cb.recordFailure(new Error('fail'));

      clock.tick(59999);
      expect(cb.canAttempt()).to.be.false;
      expect(cb.getState()).to.equal(CircuitState.OPEN);
    });
  });

  describe('OPEN -> HALF_OPEN after timeout', function() {
    it('should transition to HALF_OPEN after timeout elapsed', function() {
      const cb = new CircuitBreaker('test', { failureThreshold: 1, timeout: 60000 });
      cb.recordFailure(new Error('fail'));
      expect(cb.getState()).to.equal(CircuitState.OPEN);

      clock.tick(60000);
      expect(cb.canAttempt()).to.be.true;
      expect(cb.getState()).to.equal(CircuitState.HALF_OPEN);
    });

    it('should reset halfOpenSuccesses and halfOpenInFlight on transition', function() {
      const cb = new CircuitBreaker('test', { failureThreshold: 1, timeout: 1000 });
      cb.recordFailure(new Error('fail'));

      clock.tick(1000);
      cb.canAttempt();
      expect(cb.getState()).to.equal(CircuitState.HALF_OPEN);

      const metrics = cb.getMetrics();
      expect(metrics.halfOpenSuccesses).to.equal(0);
    });
  });

  describe('HALF_OPEN state', function() {
    function createHalfOpenBreaker(config?: Record<string, number>): CircuitBreaker {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        timeout: 1000,
        successThreshold: 2,
        halfOpenMaxInFlight: 1,
        ...config
      });
      cb.recordFailure(new Error('fail'));
      clock.tick(1000);
      cb.canAttempt(); // transitions OPEN -> HALF_OPEN (does NOT consume a permit)
      return cb;
    }

    it('should limit concurrent probes via halfOpenMaxInFlight', function() {
      const cb = createHalfOpenBreaker({ halfOpenMaxInFlight: 1 });
      // The OPEN->HALF_OPEN transition call does not increment halfOpenInFlight.
      // Next canAttempt hits HALF_OPEN case, increments inFlight to 1, returns true.
      expect(cb.canAttempt()).to.be.true;
      // Now inFlight=1 >= halfOpenMaxInFlight=1, so rejected.
      expect(cb.canAttempt()).to.be.false;
    });

    it('should allow more probes when halfOpenMaxInFlight > 1', function() {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        timeout: 1000,
        halfOpenMaxInFlight: 3
      });
      cb.recordFailure(new Error('fail'));
      clock.tick(1000);

      expect(cb.canAttempt()).to.be.true; // transitions OPEN -> HALF_OPEN (no permit consumed)
      expect(cb.canAttempt()).to.be.true; // HALF_OPEN: inFlight 0->1
      expect(cb.canAttempt()).to.be.true; // HALF_OPEN: inFlight 1->2
      expect(cb.canAttempt()).to.be.true; // HALF_OPEN: inFlight 2->3
      expect(cb.canAttempt()).to.be.false; // 3 >= 3, rejected
    });

    it('should increment halfOpenInFlight on canAttempt in HALF_OPEN', function() {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        timeout: 1000,
        halfOpenMaxInFlight: 2
      });
      cb.recordFailure(new Error('fail'));
      clock.tick(1000);

      cb.canAttempt(); // transition (no permit consumed)
      cb.canAttempt(); // HALF_OPEN: inFlight 0->1
      cb.canAttempt(); // HALF_OPEN: inFlight 1->2
      expect(cb.canAttempt()).to.be.false; // 2 >= 2, rejected
    });
  });

  describe('HALF_OPEN -> CLOSED after success threshold', function() {
    it('should transition to CLOSED after enough successes', function() {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        timeout: 1000,
        successThreshold: 2,
        halfOpenMaxInFlight: 2
      });
      cb.recordFailure(new Error('fail'));
      clock.tick(1000);

      cb.canAttempt(); // transition to HALF_OPEN, permit 1
      cb.recordSuccess(); // decrement inFlight, halfOpenSuccesses = 1
      expect(cb.getState()).to.equal(CircuitState.HALF_OPEN);

      cb.canAttempt(); // permit 2
      cb.recordSuccess(); // halfOpenSuccesses = 2 >= successThreshold
      expect(cb.getState()).to.equal(CircuitState.CLOSED);
    });

    it('should reset consecutiveFailures when transitioning to CLOSED', function() {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        timeout: 1000,
        successThreshold: 1
      });
      cb.recordFailure(new Error('fail'));
      clock.tick(1000);

      cb.canAttempt();
      cb.recordSuccess();
      expect(cb.getState()).to.equal(CircuitState.CLOSED);
      expect(cb.getMetrics().consecutiveFailures).to.equal(0);
    });
  });

  describe('HALF_OPEN -> OPEN on failure', function() {
    it('should transition back to OPEN on any failure in HALF_OPEN', function() {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        timeout: 1000,
        halfOpenMaxInFlight: 1
      });
      cb.recordFailure(new Error('initial'));
      clock.tick(1000);

      cb.canAttempt(); // transition to HALF_OPEN
      cb.recordFailure(new Error('probe failed'));
      expect(cb.getState()).to.equal(CircuitState.OPEN);
    });

    it('should decrement halfOpenInFlight on failure in HALF_OPEN', function() {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        timeout: 1000,
        halfOpenMaxInFlight: 2
      });
      cb.recordFailure(new Error('initial'));
      clock.tick(1000);

      cb.canAttempt(); // transition to HALF_OPEN, inFlight=1
      // Record failure transitions to OPEN, but decrements inFlight first
      cb.recordFailure(new Error('probe failed'));
      expect(cb.getState()).to.equal(CircuitState.OPEN);
    });

    it('should reset halfOpenSuccesses on failure', function() {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        timeout: 1000,
        successThreshold: 3,
        halfOpenMaxInFlight: 3
      });
      cb.recordFailure(new Error('initial'));
      clock.tick(1000);

      cb.canAttempt(); // transition to HALF_OPEN
      cb.recordSuccess(); // halfOpenSuccesses = 1

      cb.canAttempt();
      cb.recordFailure(new Error('probe failed'));
      expect(cb.getState()).to.equal(CircuitState.OPEN);

      // Transition back to HALF_OPEN and verify successes reset
      clock.tick(1000);
      cb.canAttempt();
      expect(cb.getMetrics().halfOpenSuccesses).to.equal(0);
    });
  });

  describe('releasePermit', function() {
    it('should release HALF_OPEN permit without recording success or failure', function() {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        timeout: 1000,
        halfOpenMaxInFlight: 1
      });
      cb.recordFailure(new Error('fail'));
      clock.tick(1000);

      cb.canAttempt(); // transition OPEN -> HALF_OPEN (no permit consumed)
      cb.canAttempt(); // HALF_OPEN: inFlight 0->1
      expect(cb.canAttempt()).to.be.false; // 1 >= 1, at max

      cb.releasePermit(); // release permit, inFlight 1->0
      expect(cb.getState()).to.equal(CircuitState.HALF_OPEN); // still HALF_OPEN
      expect(cb.canAttempt()).to.be.true; // can attempt again (inFlight 0->1)
    });

    it('should not affect state when not in HALF_OPEN', function() {
      const cb = new CircuitBreaker('test');
      expect(cb.getState()).to.equal(CircuitState.CLOSED);
      cb.releasePermit(); // no-op
      expect(cb.getState()).to.equal(CircuitState.CLOSED);
    });

    it('should not decrement below 0', function() {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        timeout: 1000,
        halfOpenMaxInFlight: 1
      });
      cb.recordFailure(new Error('fail'));
      clock.tick(1000);

      cb.canAttempt(); // transition, inFlight=1
      cb.releasePermit(); // inFlight=0
      cb.releasePermit(); // should not go below 0
      cb.releasePermit(); // should not go below 0

      // Should still be able to get exactly 1 permit
      expect(cb.canAttempt()).to.be.true;
      expect(cb.canAttempt()).to.be.false;
    });
  });

  describe('getMetrics', function() {
    it('should return correct metrics in initial state', function() {
      const cb = new CircuitBreaker('test');
      const metrics = cb.getMetrics();
      expect(metrics).to.deep.include({
        state: CircuitState.CLOSED,
        failureRate: 0,
        recentAttempts: 0,
        consecutiveFailures: 0,
        halfOpenSuccesses: 0
      });
      expect(metrics.lastFailureTime).to.be.undefined;
    });

    it('should track failure rate correctly', function() {
      const cb = new CircuitBreaker('test', { failureThreshold: 100 });
      cb.recordSuccess();
      cb.recordSuccess();
      cb.recordFailure(new Error('fail'));
      cb.recordSuccess();

      const metrics = cb.getMetrics();
      expect(metrics.failureRate).to.equal(0.25); // 1 failure out of 4
      expect(metrics.recentAttempts).to.equal(4);
    });

    it('should include lastFailureTime after a failure', function() {
      const cb = new CircuitBreaker('test', { failureThreshold: 100 });
      const now = Date.now();
      cb.recordFailure(new Error('fail'));

      const metrics = cb.getMetrics();
      expect(metrics.lastFailureTime).to.be.instanceOf(Date);
      expect(metrics.lastFailureTime!.getTime()).to.equal(now);
    });

    it('should clean old attempts from monitoring window', function() {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 100,
        monitoringWindow: 5000
      });

      cb.recordSuccess();
      cb.recordFailure(new Error('fail'));
      expect(cb.getMetrics().recentAttempts).to.equal(2);

      clock.tick(5001);
      // After monitoring window, old attempts are cleaned
      expect(cb.getMetrics().recentAttempts).to.equal(0);
    });

    it('should report correct consecutiveFailures', function() {
      const cb = new CircuitBreaker('test', { failureThreshold: 100 });
      cb.recordFailure(new Error('1'));
      cb.recordFailure(new Error('2'));
      cb.recordFailure(new Error('3'));

      expect(cb.getMetrics().consecutiveFailures).to.equal(3);
    });

    it('should report halfOpenSuccesses in HALF_OPEN', function() {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        timeout: 1000,
        successThreshold: 5,
        halfOpenMaxInFlight: 5
      });
      cb.recordFailure(new Error('fail'));
      clock.tick(1000);

      cb.canAttempt(); // transition to HALF_OPEN
      cb.recordSuccess();
      cb.canAttempt();
      cb.recordSuccess();

      expect(cb.getMetrics().halfOpenSuccesses).to.equal(2);
    });
  });

  describe('custom config', function() {
    it('should merge partial config with defaults', function() {
      const cb = new CircuitBreaker('test', { failureThreshold: 10 });
      // Use consecutive failures to verify the custom threshold
      const err = new Error('fail');
      for (let i = 0; i < 9; i++) {
        cb.recordFailure(err);
      }
      expect(cb.getState()).to.equal(CircuitState.CLOSED);

      cb.recordFailure(err);
      expect(cb.getState()).to.equal(CircuitState.OPEN);
    });
  });

  describe('full lifecycle', function() {
    it('should complete a full CLOSED -> OPEN -> HALF_OPEN -> CLOSED cycle', function() {
      const cb = new CircuitBreaker('lifecycle', {
        failureThreshold: 2,
        timeout: 5000,
        successThreshold: 2,
        halfOpenMaxInFlight: 2
      });

      // Start CLOSED
      expect(cb.getState()).to.equal(CircuitState.CLOSED);
      expect(cb.canAttempt()).to.be.true;

      // Trigger OPEN via consecutive failures
      cb.recordFailure(new Error('err1'));
      cb.recordFailure(new Error('err2'));
      expect(cb.getState()).to.equal(CircuitState.OPEN);
      expect(cb.canAttempt()).to.be.false;

      // Wait for timeout -> HALF_OPEN
      clock.tick(5000);
      expect(cb.canAttempt()).to.be.true;
      expect(cb.getState()).to.equal(CircuitState.HALF_OPEN);

      // First success in HALF_OPEN
      cb.recordSuccess();
      expect(cb.getState()).to.equal(CircuitState.HALF_OPEN);

      // Second success -> CLOSED
      cb.canAttempt();
      cb.recordSuccess();
      expect(cb.getState()).to.equal(CircuitState.CLOSED);
      expect(cb.canAttempt()).to.be.true;
    });

    it('should handle CLOSED -> OPEN -> HALF_OPEN -> OPEN -> HALF_OPEN -> CLOSED', function() {
      const cb = new CircuitBreaker('complex', {
        failureThreshold: 1,
        timeout: 1000,
        successThreshold: 1,
        halfOpenMaxInFlight: 1
      });

      // CLOSED -> OPEN
      cb.recordFailure(new Error('err'));
      expect(cb.getState()).to.equal(CircuitState.OPEN);

      // OPEN -> HALF_OPEN
      clock.tick(1000);
      cb.canAttempt();
      expect(cb.getState()).to.equal(CircuitState.HALF_OPEN);

      // HALF_OPEN -> OPEN (probe fails)
      cb.recordFailure(new Error('probe fail'));
      expect(cb.getState()).to.equal(CircuitState.OPEN);

      // OPEN -> HALF_OPEN again
      clock.tick(1000);
      cb.canAttempt();
      expect(cb.getState()).to.equal(CircuitState.HALF_OPEN);

      // HALF_OPEN -> CLOSED (probe succeeds)
      cb.recordSuccess();
      expect(cb.getState()).to.equal(CircuitState.CLOSED);
    });
  });
});
