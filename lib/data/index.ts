import { LiveProvider } from './live-provider';
import { SimProvider } from './sim-provider';
import type { DataProvider, ProviderKind } from './types';

export * from './types';

/** Inlined by next.config.mjs so the same name resolves on both sides. */
export const DATA_SOURCE: ProviderKind =
  (process.env.DATA_SOURCE as ProviderKind | undefined) ?? 'sim';

let provider: DataProvider | null = null;

/**
 * The one place an implementation is chosen. P1 is this switch and nothing
 * else: every component reads through the DataProvider interface.
 */
export function getProvider(): DataProvider {
  if (!provider) {
    provider = DATA_SOURCE === 'live' ? new LiveProvider() : new SimProvider();
  }
  return provider;
}
