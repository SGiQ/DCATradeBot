import { describe, it, expect } from 'vitest';
import { buildSignedUrl, verifyApprovalSig } from './liveGate.js';

const SECRET = 'test-secret-that-is-long-enough-32ch';
const ID = '550e8400-e29b-41d4-a716-446655440000';

describe('buildSignedUrl', () => {
  it('produces a URL with id and sig params when secret is set', () => {
    const url = buildSignedUrl('https://bot.example.com/approve', ID, SECRET);
    expect(url).toContain(`id=${ID}`);
    expect(url).toContain('sig=');
  });

  it('produces an unsigned URL when no secret is set', () => {
    const url = buildSignedUrl('https://bot.example.com/approve', ID, undefined);
    expect(url).not.toContain('sig=');
    expect(url).toContain(`id=${ID}`);
  });
});

describe('verifyApprovalSig', () => {
  it('returns true for a valid HMAC signature', () => {
    const url = new URL(buildSignedUrl('https://bot.example.com/approve', ID, SECRET));
    const sig = url.searchParams.get('sig');
    expect(verifyApprovalSig(ID, sig, SECRET)).toBe(true);
  });

  it('returns false for a tampered ID', () => {
    const url = new URL(buildSignedUrl('https://bot.example.com/approve', ID, SECRET));
    const sig = url.searchParams.get('sig');
    const tamperedId = ID.replace('550e', 'aaaa');
    expect(verifyApprovalSig(tamperedId, sig, SECRET)).toBe(false);
  });

  it('returns false for a missing sig', () => {
    expect(verifyApprovalSig(ID, null, SECRET)).toBe(false);
  });

  it('returns true when no secret is configured (backwards compatible)', () => {
    expect(verifyApprovalSig(ID, null, undefined)).toBe(true);
  });
});
