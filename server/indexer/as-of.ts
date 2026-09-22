/**
 * "Now", for every window the site measures back from.
 *
 * §14: the trailing windows end at the last block indexed, not at wall
 * clock. That has always meant the cursor's chain time — and the cursor
 * can be moved back. A repair rewound it by millions of blocks on the box
 * (§24) while every row behind it was still in the tables, and the board
 * measured its 24 hours from a point months before the newest row: near
 * enough empty, over data that was all still there.
 *
 * So "now" is the newest row the indexer has written, or the cursor's time
 * if that is later — which, on a healthy box, it always is. The cursor
 * still says where reading resumes; this says how far the data reaches.
 */

import { prisma } from '../db';

export async function indexedAsOf(cursorTime: Date): Promise<Date> {
  const [swap] = await prisma.$queryRaw<{ at: Date | null }[]>`
    SELECT block_time AS at FROM swap_events ORDER BY block_num DESC LIMIT 1
  `;
  const [liquidity] = await prisma.$queryRaw<{ at: Date | null }[]>`
    SELECT block_time AS at FROM liquidity_events ORDER BY block_num DESC LIMIT 1
  `;
  let asOf = cursorTime;
  for (const row of [swap, liquidity]) {
    if (row?.at && row.at.getTime() > asOf.getTime()) asOf = row.at;
  }
  return asOf;
}
