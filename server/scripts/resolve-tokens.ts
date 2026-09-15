/**
 * Turn what a person types into token addresses.
 *
 * Every probe takes "a token", and a person has a ticker off the board, not a
 * forty-character address. `logos:probe` resolved a symbol and `market:probe`
 * did not, which is the kind of difference nobody should have to remember —
 * so both use this.
 *
 * An address is taken as given and costs no query, which keeps a probe
 * working when the database is down; a symbol is looked up in the indexer's
 * own tables and resolves to the one with the most volume, the same ranking
 * the board uses when a symbol is not unique.
 */

export interface NamedToken {
  address: string;
  /** Empty when an address was given and nothing has been looked up. */
  symbol: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function resolveTokens(
  args: string[],
  say: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<NamedToken[]> {
  const out: NamedToken[] = [];
  const symbols = args.filter((arg) => !ADDRESS.test(arg));
  // Imported only when a symbol is given, so an address-only probe needs no
  // database — `verify:chain` learnt that lesson the hard way (§16).
  const prisma = symbols.length > 0 ? (await import('../db')).prisma : null;

  for (const arg of args) {
    if (ADDRESS.test(arg)) {
      out.push({ address: arg.toLowerCase(), symbol: '' });
      continue;
    }
    const rows = await prisma!.$queryRaw<NamedToken[]>`
      WITH latest AS (SELECT MAX(hour) AS newest FROM pool_fee_hourly),
      volume AS (
        SELECT f.pool_id, SUM(f.volume_usd) AS volume
        FROM pool_fee_hourly f, latest
        WHERE f.hour > latest.newest - interval '24 hours'
        GROUP BY f.pool_id
      )
      SELECT t.address, t.symbol
      FROM tokens t
      LEFT JOIN pools p ON lower(p.token0) = lower(t.address) OR lower(p.token1) = lower(t.address)
      LEFT JOIN volume v ON v.pool_id = p.id
      WHERE lower(t.symbol) = lower(${arg})
      GROUP BY t.address, t.symbol
      ORDER BY MAX(COALESCE(v.volume, 0)) DESC NULLS LAST, t.first_seen ASC
      LIMIT 1
    `;
    if (rows.length === 0) say(`no token called ${arg} in the indexer's tables`);
    else out.push(rows[0]);
  }
  return out;
}
