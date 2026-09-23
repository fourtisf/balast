import type { UserPosition } from './data/types';

/**
 * A position's identity on the page.
 *
 * A token id alone is not one: v3's NonfungiblePositionManager and v4's
 * PositionManager number their NFTs independently, so a wallet can hold v3
 * #812 and v4 #812 at once, and a fee reading, a busy row or a React key
 * keyed on the bare id would give one position the other's state. The
 * manager is part of the identity. Simulated positions have no manager and
 * keep their bare id.
 */
export function positionRef(position: Pick<UserPosition, 'tokenId' | 'live'>): string {
  return position.live ? `${position.live.protocol}:${position.tokenId}` : position.tokenId;
}
