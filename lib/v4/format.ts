import { formatUnits, parseUnits } from 'viem';

/** A token amount for reading: up to six significant digits, no trailing zeros, thin thousands. */
export function amount(raw: bigint, decimals: number): string {
  const n = Number(formatUnits(raw, decimals));
  if (n === 0) return '0';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const digits = Math.max(0, 5 - Math.floor(Math.log10(Math.abs(n))));
  return n.toLocaleString('en-US', { maximumFractionDigits: Math.min(digits, decimals), minimumFractionDigits: 0 });
}

/** The deposit field, as raw units; NaN and negatives become zero rather than throwing mid-keystroke. */
export function toRaw(input: string | number, decimals: number): bigint {
  const text = String(input).trim();
  if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') return 0n;
  try {
    return parseUnits(text, decimals);
  } catch {
    return 0n;
  }
}

/** A price or ratio for reading: five significant digits, never scientific notation. */
export function num(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const digits = Math.max(0, 4 - Math.floor(Math.log10(Math.abs(n))));
  return n.toLocaleString('en-US', { maximumFractionDigits: Math.min(digits, 18) });
}
