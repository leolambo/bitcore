import { expect } from 'chai';
import { redactUrl } from '../../../src/providers/chain-state/external/utils/redactUrl';

describe('redactUrl', () => {
  it('should redact Alchemy v2 API key from URL', () => {
    const url = 'https://eth-mainnet.g.alchemy.com/v2/abc123def456';
    expect(redactUrl(url)).to.not.include('abc123def456');
    expect(redactUrl(url)).to.include('REDACTED');
  });

  it('should redact Alchemy v3 API key from URL', () => {
    const url = 'https://eth-mainnet.g.alchemy.com/v3/abc123def456';
    expect(redactUrl(url)).to.not.include('abc123def456');
    expect(redactUrl(url)).to.include('REDACTED');
  });

  it('should redact apikey query parameter', () => {
    const url = 'https://api.example.com/data?apikey=secretkey123&chain=eth';
    expect(redactUrl(url)).to.not.include('secretkey123');
    expect(redactUrl(url)).to.include('chain=eth');
  });

  it('should redact api_key query parameter', () => {
    const url = 'https://api.example.com/data?api_key=secretkey123';
    expect(redactUrl(url)).to.not.include('secretkey123');
  });

  it('should redact key query parameter', () => {
    const url = 'https://api.example.com/data?key=secretkey123';
    expect(redactUrl(url)).to.not.include('secretkey123');
  });

  it('should return URL unchanged if no keys present', () => {
    const url = 'https://api.example.com/data?chain=eth';
    expect(redactUrl(url)).to.eq(url);
  });

  it('should handle empty string', () => {
    expect(redactUrl('')).to.eq('');
  });
});
