import { expect } from 'chai';
import {
  AdapterError,
  NotFoundError,
  InvalidRequestError,
  AuthError,
  RateLimitError,
  TimeoutError,
  UpstreamError,
  AllProvidersUnavailableError
} from '../../../src/providers/chain-state/external/adapters/errors';

describe('Error Taxonomy', function() {

  describe('AdapterError (base class)', function() {
    it('should extend Error', function() {
      const err = new AdapterError('test message', 'TestProvider');
      expect(err).to.be.instanceOf(Error);
      expect(err).to.be.instanceOf(AdapterError);
    });

    it('should set name to constructor name', function() {
      const err = new AdapterError('test', 'TestProvider');
      expect(err.name).to.equal('AdapterError');
    });

    it('should store providerName', function() {
      const err = new AdapterError('test', 'Moralis');
      expect(err.providerName).to.equal('Moralis');
    });

    it('should default isBreakerable to true', function() {
      const err = new AdapterError('test', 'TestProvider');
      expect(err.isBreakerable).to.equal(true);
    });

    it('should allow overriding isBreakerable to false', function() {
      const err = new AdapterError('test', 'TestProvider', false);
      expect(err.isBreakerable).to.equal(false);
    });

    it('should set the message', function() {
      const err = new AdapterError('something broke', 'TestProvider');
      expect(err.message).to.equal('something broke');
    });

    it('should have a stack trace', function() {
      const err = new AdapterError('test', 'TestProvider');
      expect(err.stack).to.be.a('string');
      expect(err.stack).to.include('AdapterError');
    });
  });

  describe('NotFoundError', function() {
    it('should extend AdapterError', function() {
      const err = new NotFoundError('Moralis', 'transaction 0xabc');
      expect(err).to.be.instanceOf(AdapterError);
      expect(err).to.be.instanceOf(Error);
    });

    it('should set isBreakerable to false', function() {
      const err = new NotFoundError('Moralis', 'transaction 0xabc');
      expect(err.isBreakerable).to.equal(false);
    });

    it('should format message with provider and resource', function() {
      const err = new NotFoundError('Moralis', 'transaction 0xabc');
      expect(err.message).to.equal('Moralis: transaction 0xabc not found');
    });

    it('should store providerName', function() {
      const err = new NotFoundError('Alchemy', 'block 12345');
      expect(err.providerName).to.equal('Alchemy');
    });

    it('should set name to NotFoundError', function() {
      const err = new NotFoundError('Moralis', 'resource');
      expect(err.name).to.equal('NotFoundError');
    });
  });

  describe('InvalidRequestError', function() {
    it('should extend AdapterError', function() {
      const err = new InvalidRequestError('Moralis', 'bad address format');
      expect(err).to.be.instanceOf(AdapterError);
      expect(err).to.be.instanceOf(Error);
    });

    it('should set isBreakerable to false', function() {
      const err = new InvalidRequestError('Moralis', 'bad address format');
      expect(err.isBreakerable).to.equal(false);
    });

    it('should format message with provider and reason', function() {
      const err = new InvalidRequestError('Moralis', 'bad address format');
      expect(err.message).to.equal('Moralis: invalid request - bad address format');
    });

    it('should store providerName', function() {
      const err = new InvalidRequestError('Alchemy', 'invalid txId');
      expect(err.providerName).to.equal('Alchemy');
    });

    it('should set name to InvalidRequestError', function() {
      const err = new InvalidRequestError('Moralis', 'reason');
      expect(err.name).to.equal('InvalidRequestError');
    });
  });

  describe('AuthError', function() {
    it('should extend AdapterError', function() {
      const err = new AuthError('Moralis');
      expect(err).to.be.instanceOf(AdapterError);
      expect(err).to.be.instanceOf(Error);
    });

    it('should set isBreakerable to true', function() {
      const err = new AuthError('Moralis');
      expect(err.isBreakerable).to.equal(true);
    });

    it('should format message with provider', function() {
      const err = new AuthError('Moralis');
      expect(err.message).to.equal('Moralis: authentication failed');
    });

    it('should store providerName', function() {
      const err = new AuthError('Alchemy');
      expect(err.providerName).to.equal('Alchemy');
    });

    it('should set name to AuthError', function() {
      const err = new AuthError('Moralis');
      expect(err.name).to.equal('AuthError');
    });
  });

  describe('RateLimitError', function() {
    it('should extend AdapterError', function() {
      const err = new RateLimitError('Moralis');
      expect(err).to.be.instanceOf(AdapterError);
      expect(err).to.be.instanceOf(Error);
    });

    it('should set isBreakerable to true', function() {
      const err = new RateLimitError('Moralis');
      expect(err.isBreakerable).to.equal(true);
    });

    it('should format message with provider', function() {
      const err = new RateLimitError('Moralis');
      expect(err.message).to.equal('Moralis: rate limited');
    });

    it('should store retryAfterMs when provided', function() {
      const err = new RateLimitError('Moralis', 5000);
      expect(err.retryAfterMs).to.equal(5000);
    });

    it('should have undefined retryAfterMs when not provided', function() {
      const err = new RateLimitError('Moralis');
      expect(err.retryAfterMs).to.equal(undefined);
    });

    it('should store providerName', function() {
      const err = new RateLimitError('Alchemy', 1000);
      expect(err.providerName).to.equal('Alchemy');
    });

    it('should set name to RateLimitError', function() {
      const err = new RateLimitError('Moralis');
      expect(err.name).to.equal('RateLimitError');
    });
  });

  describe('TimeoutError', function() {
    it('should extend AdapterError', function() {
      const err = new TimeoutError('Moralis', 5000);
      expect(err).to.be.instanceOf(AdapterError);
      expect(err).to.be.instanceOf(Error);
    });

    it('should set isBreakerable to true', function() {
      const err = new TimeoutError('Moralis', 5000);
      expect(err.isBreakerable).to.equal(true);
    });

    it('should format message with provider and timeout value', function() {
      const err = new TimeoutError('Moralis', 5000);
      expect(err.message).to.equal('Moralis: request timed out after 5000ms');
    });

    it('should store providerName', function() {
      const err = new TimeoutError('Alchemy', 3000);
      expect(err.providerName).to.equal('Alchemy');
    });

    it('should set name to TimeoutError', function() {
      const err = new TimeoutError('Moralis', 5000);
      expect(err.name).to.equal('TimeoutError');
    });
  });

  describe('UpstreamError', function() {
    it('should extend AdapterError', function() {
      const err = new UpstreamError('Moralis');
      expect(err).to.be.instanceOf(AdapterError);
      expect(err).to.be.instanceOf(Error);
    });

    it('should set isBreakerable to true', function() {
      const err = new UpstreamError('Moralis');
      expect(err.isBreakerable).to.equal(true);
    });

    it('should format message with provider only when no optional args', function() {
      const err = new UpstreamError('Moralis');
      expect(err.message).to.equal('Moralis: upstream error');
    });

    it('should include status code in message when provided', function() {
      const err = new UpstreamError('Moralis', 502);
      expect(err.message).to.equal('Moralis: upstream error (502)');
    });

    it('should include detail in message when provided', function() {
      const err = new UpstreamError('Moralis', undefined, 'bad gateway');
      expect(err.message).to.equal('Moralis: upstream error: bad gateway');
    });

    it('should include both status code and detail when both provided', function() {
      const err = new UpstreamError('Moralis', 503, 'service unavailable');
      expect(err.message).to.equal('Moralis: upstream error (503): service unavailable');
    });

    it('should store providerName', function() {
      const err = new UpstreamError('Alchemy', 500);
      expect(err.providerName).to.equal('Alchemy');
    });

    it('should set name to UpstreamError', function() {
      const err = new UpstreamError('Moralis');
      expect(err.name).to.equal('UpstreamError');
    });
  });

  describe('AllProvidersUnavailableError', function() {
    it('should extend Error', function() {
      const err = new AllProvidersUnavailableError('getBalanceForAddress', 'ETH', 'mainnet');
      expect(err).to.be.instanceOf(Error);
    });

    it('should NOT extend AdapterError', function() {
      const err = new AllProvidersUnavailableError('getBalanceForAddress', 'ETH', 'mainnet');
      expect(err).to.not.be.instanceOf(AdapterError);
    });

    it('should format message with operation, chain, and network', function() {
      const err = new AllProvidersUnavailableError('getBalanceForAddress', 'ETH', 'mainnet');
      expect(err.message).to.equal('All indexed API providers unavailable for getBalanceForAddress on ETH:mainnet');
    });

    it('should set name to AllProvidersUnavailableError', function() {
      const err = new AllProvidersUnavailableError('getTransactions', 'MATIC', 'mainnet');
      expect(err.name).to.equal('AllProvidersUnavailableError');
    });

    it('should not have providerName property', function() {
      const err = new AllProvidersUnavailableError('getBalanceForAddress', 'ETH', 'mainnet');
      expect(err).to.not.have.property('providerName');
    });

    it('should not have isBreakerable property', function() {
      const err = new AllProvidersUnavailableError('getBalanceForAddress', 'ETH', 'mainnet');
      expect(err).to.not.have.property('isBreakerable');
    });
  });

  describe('isBreakerable classification', function() {
    it('non-breakerable errors: NotFoundError, InvalidRequestError', function() {
      const notFound = new NotFoundError('Moralis', 'tx');
      const invalidReq = new InvalidRequestError('Moralis', 'bad input');
      expect(notFound.isBreakerable).to.equal(false);
      expect(invalidReq.isBreakerable).to.equal(false);
    });

    it('breakerable errors: AuthError, RateLimitError, TimeoutError, UpstreamError', function() {
      const auth = new AuthError('Moralis');
      const rateLimit = new RateLimitError('Moralis');
      const timeout = new TimeoutError('Moralis', 5000);
      const upstream = new UpstreamError('Moralis');
      expect(auth.isBreakerable).to.equal(true);
      expect(rateLimit.isBreakerable).to.equal(true);
      expect(timeout.isBreakerable).to.equal(true);
      expect(upstream.isBreakerable).to.equal(true);
    });
  });

  describe('catch behavior', function() {
    it('should be catchable as AdapterError for all adapter errors', function() {
      const errors = [
        new NotFoundError('P', 'r'),
        new InvalidRequestError('P', 'r'),
        new AuthError('P'),
        new RateLimitError('P'),
        new TimeoutError('P', 1000),
        new UpstreamError('P')
      ];

      for (const err of errors) {
        let caught = false;
        try {
          throw err;
        } catch (e) {
          if (e instanceof AdapterError) {
            caught = true;
          }
        }
        expect(caught, `${err.name} should be catchable as AdapterError`).to.equal(true);
      }
    });

    it('AllProvidersUnavailableError should NOT be catchable as AdapterError', function() {
      const err = new AllProvidersUnavailableError('op', 'ETH', 'mainnet');
      let caughtAsAdapter = false;
      let caughtAsError = false;
      try {
        throw err;
      } catch (e) {
        if (e instanceof AdapterError) {
          caughtAsAdapter = true;
        }
        if (e instanceof Error) {
          caughtAsError = true;
        }
      }
      expect(caughtAsAdapter).to.equal(false);
      expect(caughtAsError).to.equal(true);
    });
  });
});
