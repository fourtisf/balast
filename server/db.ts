/**
 * One Prisma client for the process.
 *
 * `globalThis` caching is not a dev-server nicety here — the indexer and the
 * API each run as their own PM2 process, and a client per module import would
 * open a connection pool per import.
 */

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
