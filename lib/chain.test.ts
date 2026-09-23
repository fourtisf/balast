import { describe, expect, it } from 'vitest';
import { getAddress, isAddress } from 'viem';
import { CONTRACTS, NATIVE_ETH } from './chain';

/**
 * viem refuses a mixed-case address whose checksum does not validate — in
 * `readContract`, `estimateGas`, `sendTransaction` and in every ABI encoding
 * of an address argument. Two of these were typed with the right bytes and a
 * wrong case (the v4 PositionManager and the v3 factory), and on the live
 * site every v4 approve, mint, collect and withdrawal failed with
 * `Address "0x…" is invalid` before reaching the chain. The unit tests could
 * not see it: they use fakes, and the local-chain check replaces these
 * addresses with freshly deployed ones.
 */
describe('contract addresses', () => {
  it.each(Object.entries({ ...CONTRACTS, NATIVE_ETH }))('%s is a valid, checksummed address', (_name, address) => {
    expect(isAddress(address)).toBe(true);
    expect(getAddress(address.toLowerCase())).toBe(address);
  });
});
