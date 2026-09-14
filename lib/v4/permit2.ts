/**
 * How PositionManager gets paid in an ERC20: through Permit2.
 *
 * `_pay` calls `permit2.transferFrom(payer, poolManager, amount, token)`, so
 * the wallet needs two allowances before its first mint of a token — the
 * token's own `approve(permit2, …)` and Permit2's `approve(token,
 * positionManager, amount, expiration)`. Ether needs neither: it rides in
 * `msg.value` and the surplus is swept back.
 */

import { parseAbi } from 'viem';

export const PERMIT2_ABI = parseAbi([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

export const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

export const MAX_UINT256 = 2n ** 256n - 1n;
export const MAX_UINT160 = 2n ** 160n - 1n;
/** Permit2 expirations are uint48 seconds; thirty days is the SDK's own default. */
export const PERMIT2_EXPIRATION_SECONDS = 30 * 24 * 60 * 60;
