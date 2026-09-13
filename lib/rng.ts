/**
 * Deterministic PRNG (mulberry32).
 *
 * The simulator has to produce the *same* first snapshot on the server and in
 * the browser or React hydration mismatches. Everything that would otherwise
 * call Math.random() at module load goes through a seeded stream instead.
 * Ticks after mount are free to diverge — they only happen client-side.
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed used for every value rendered on the first paint. */
export const SIM_SEED = 4663; // chainId, because it had to be something.
