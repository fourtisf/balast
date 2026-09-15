/**
 * The heartbeat for stages that write no block (working.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import { WORKING_KEY, clearWork, readWork, withWork } from './working';

beforeAll(async () => {
  if (!(await isReachable())) {
    throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  }
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a recorded stage', () => {
  it('is written at start, beats while it runs, carries the latest note, and is gone at the end', async () => {
    let first: Awaited<ReturnType<typeof readWork>> = null;
    let later: Awaited<ReturnType<typeof readWork>> = null;
    const result = await withWork(
      'full rebuild',
      async (note) => {
        first = await readWork();
        note('fees');
        // Long enough for several beats at the test cadence.
        await sleep(120);
        later = await readWork();
        return 42;
      },
      { heartbeatMs: 20 },
    );
    expect(result).toBe(42);
    expect(first).not.toBeNull();
    expect(first!.stage).toBe('full rebuild');
    expect(first!.detail).toBeUndefined();
    expect(later).not.toBeNull();
    expect(later!.detail).toBe('fees');
    expect(later!.startedAt).toBe(first!.startedAt);
    expect(Date.parse(later!.heartbeatAt)).toBeGreaterThan(Date.parse(first!.heartbeatAt));
    expect(await readWork()).toBeNull();
  });

  it('is gone when the stage throws, and the error is the caller\'s', async () => {
    await expect(
      withWork('v3 history: pools', async () => {
        throw new Error('endpoint refused 64 blocks');
      }),
    ).rejects.toThrow('endpoint refused');
    expect(await readWork()).toBeNull();
  });

  it('is read as no record when malformed, and cleared on request', async () => {
    await prisma.indexerState.create({ data: { key: WORKING_KEY, value: '{not json', updatedAt: new Date() } });
    expect(await readWork()).toBeNull();
    await prisma.indexerState.update({ where: { key: WORKING_KEY }, data: { value: JSON.stringify({ stage: 1 }) } });
    expect(await readWork()).toBeNull();
    await clearWork();
    expect(await prisma.indexerState.findUnique({ where: { key: WORKING_KEY } })).toBeNull();
    // Clearing nothing is not an error: it runs at every start.
    await clearWork();
  });
});
