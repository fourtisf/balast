import { describe, expect, it } from 'vitest';
import { PUBLIC_RPC_URLS } from '../../lib/chain';
import { RPC_URLS, rpcStartIndex } from './endpoints';

describe('RPC endpoints', () => {
  it('default to the free public list the page also reads through', () => {
    if (!process.env.RPC_URLS) expect([...RPC_URLS]).toEqual([...PUBLIC_RPC_URLS]);
    expect(PUBLIC_RPC_URLS.length).toBeGreaterThan(1);
  });

  it('start each process where RPC_START says, and nowhere odd', () => {
    expect(rpcStartIndex(4, undefined)).toBe(0);
    expect(rpcStartIndex(4, '1')).toBe(1);
    expect(rpcStartIndex(4, '6')).toBe(2);
    expect(rpcStartIndex(4, '-1')).toBe(0);
    expect(rpcStartIndex(4, 'x')).toBe(0);
    expect(rpcStartIndex(0, '2')).toBe(0);
  });
});
