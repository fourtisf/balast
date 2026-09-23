/**
 * End to end against Uniswap's own contracts, on a local chain.
 *
 * Every liquidity action the site can send — mint, collect, withdraw, on v3
 * and on v4, paying and receiving ether — is run here through the SAME
 * functions the pages call (plan, dry run, send, receipt), against Uniswap's
 * published bytecode: v3-core and v3-periphery from npm, v4-core and
 * v4-periphery from their npm packages, Permit2 at its canonical address.
 * Nothing is mocked below the RPC. After each step the script checks where
 * every wei went: that the wallet got the NFT and then its money back, and
 * that no Uniswap contract was left holding any of it.
 *
 * Setup, in a scratch directory outside the repository (LP_ARTIFACTS):
 *
 *   npm init -y && npm i hardhat@2
 *   # hardhat.config.js:
 *   #   module.exports = { networks: { hardhat: { chainId: 4663,
 *   #     allowUnlimitedContractSize: true, hardfork: 'cancun' } } };
 *   npx hardhat node --port 8545 &
 *   npm pack @uniswap/v4-core @uniswap/v4-periphery
 *   #   untar them to v4c/ and v4p/
 *   # Permit2's runtime bytecode, from the hex literal in
 *   #   v4p/lib/permit2/test/utils/DeployPermit2.sol, into permit2.runtime.hex
 *
 * Then, from the repository:
 *
 *   LP_ARTIFACTS=/path/to/dir npm run check:lp
 *
 * v3's bytecode comes from this repository's own node_modules. LP_RPC
 * overrides the node (default http://127.0.0.1:8545).
 *
 * It exits non-zero if any check fails.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  http,
  parseAbi,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { CHAIN, CONTRACTS, NATIVE_ETH } from '../../lib/chain';

const RPC = process.env.LP_RPC ?? 'http://127.0.0.1:8545';
const ART = process.env.LP_ARTIFACTS ?? '';
const REPO = join(__dirname, '..', '..');

const chain = {
  id: CHAIN.id,
  name: 'local',
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [RPC] } },
} as const;
const pub = createPublicClient({ chain, transport: http(RPC) });

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message: string; data?: unknown } };
  if (body.error) {
    const e = new Error(body.error.message) as Error & { data?: unknown };
    e.data = body.error.data;
    throw e;
  }
  return body.result;
}
/** The wallet the pages would be handed: an EIP-1193 provider over the node's unlocked accounts. */
const provider = { request: ({ method, params }: { method: string; params?: unknown[] }) => rpc(method, params ?? []) };

let failures = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${what}`);
  if (!ok) failures += 1;
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}

function artifact(path: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(path, 'utf8')) as { abi: Abi; bytecode: string | { object: string } };
  const bytecode = typeof json.bytecode === 'string' ? json.bytecode : json.bytecode.object;
  return { abi: json.abi, bytecode: (bytecode.startsWith('0x') ? bytecode : `0x${bytecode}`) as Hex };
}

async function main(): Promise<void> {
  if (!ART) throw new Error('Set LP_ARTIFACTS to the directory holding v4c/ and v4p/ (see the header).');
  const [deployer, user, trader] = (await rpc('eth_accounts')) as Address[];
  const as = (account: Address) => createWalletClient({ chain, account, transport: custom(provider) });

  async function deploy(a: { abi: Abi; bytecode: Hex }, args: unknown[] = []): Promise<Address> {
    const hash = await as(deployer).deployContract({ abi: a.abi, bytecode: a.bytecode, args });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error('deploy failed');
    return receipt.contractAddress;
  }
  async function send(account: Address, to: Address, data: Hex, value = 0n): Promise<void> {
    const hash = await as(account).sendTransaction({ to, data, value });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`transaction to ${to} reverted`);
  }
  async function spent(hash: Hex): Promise<bigint> {
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error('reverted');
    return r.gasUsed * r.effectiveGasPrice;
  }

  // ------------------------------------------------------------ contracts --
  section('deploying Uniswap from its published bytecode');
  const nm = join(REPO, 'node_modules', '@uniswap');
  const WETH = artifact(join(ART, 'v4p/foundry-out/WETH.sol/WETH.default.json'));
  const TOKEN = artifact(join(ART, 'v4p/foundry-out/MockERC20.sol/MockERC20.json'));
  const weth = await deploy(WETH);
  const factory = await deploy(artifact(join(nm, 'v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json')));
  const npmArt = artifact(join(nm, 'v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'));
  const npm = await deploy(npmArt, [factory, weth, deployer]);
  const routerArt = artifact(join(nm, 'v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json'));
  const router = await deploy(routerArt, [factory, weth]);
  const poolManager = await deploy(artifact(join(ART, 'v4c/out/PoolManager.sol/PoolManager.json')), [deployer]);
  await rpc('hardhat_setCode', [CONTRACTS.permit2, readFileSync(join(ART, 'permit2.runtime.hex'), 'utf8').trim()]);
  const posm = await deploy(artifact(join(ART, 'v4p/foundry-out/PositionManager.sol/PositionManager.json')), [
    poolManager,
    CONTRACTS.permit2,
    300_000n,
    deployer,
    weth,
  ]);
  const stateView = await deploy(artifact(join(ART, 'v4p/foundry-out/StateView.sol/StateView.json')), [poolManager]);
  const swapTestArt = artifact(join(ART, 'v4c/out/PoolSwapTest.sol/PoolSwapTest.json'));
  const swapTest = await deploy(swapTestArt, [poolManager]);
  const viemConstants = readFileSync(join(REPO, 'node_modules/viem/_esm/constants/contracts.js'), 'utf8');
  const multicall3 = await deploy({ abi: [], bytecode: viemConstants.match(/multicall3Bytecode = '(0x[0-9a-f]+)'/)![1] as Hex });

  // The site's modules read these addresses; point them at this chain before
  // importing anything that captures them.
  Object.assign(CONTRACTS as Record<string, string>, {
    weth,
    v3Factory: factory,
    v3PositionManager: npm,
    poolManager,
    positionManager: posm,
    stateView,
    multicall3,
  });
  console.log(`  weth ${weth}\n  v3 manager ${npm}\n  v4 PositionManager ${posm}\n  PoolManager ${poolManager}`);

  const { planV3Mint } = await import('../../lib/v3/mint');
  const { readV3Slot0, simulateV3Mint, sendV3Mint, waitForV3Mint, v3ApprovalsNeeded, approveV3 } = await import('../../lib/v3/flow');
  const { planV3Collect, planV3Withdraw } = await import('../../lib/v3/manage');
  const { readV3Positions, readV3Fees, readV3Weth9 } = await import('../../lib/v3/positions');
  const { burnAmountsWithSlippage } = await import('../../lib/v3/amounts');
  const { planMint } = await import('../../lib/v4/mint');
  const flow = await import('../../lib/v4/flow');
  const { planCollect, planWithdraw } = await import('../../lib/v4/manage');
  const { readPositionFees } = await import('../../lib/v4/fees');
  const { readV4Positions, readNextTokenId, readOwners } = await import('../../lib/v4/positions');
  const { getSqrtRatioAtTick } = await import('../../lib/v4/tick-math');

  const ERC20 = parseAbi([
    'function mint(address to, uint256 amount)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
  ]);
  const balanceOf = (token: Address, who: Address) =>
    token === NATIVE_ETH ? pub.getBalance({ address: who }) : pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] });
  /** What a contract holds of each asset: must be zero after every action. */
  async function holds(who: Address, tokens: Address[]): Promise<bigint> {
    let total = await pub.getBalance({ address: who });
    for (const t of tokens) total += await balanceOf(t, who);
    return total;
  }

  const tkn = await deploy(TOKEN, ['Test Token', 'TKN', 18]);
  for (const who of [user, trader]) {
    await send(deployer, tkn, encodeFunctionData({ abi: ERC20, functionName: 'mint', args: [who, parseEther('1000000')] }));
  }
  // The trader holds wrapped ether to swap with.
  await send(trader, weth, encodeFunctionData({ abi: parseAbi(['function deposit() payable']), functionName: 'deposit' }), parseEther('100'));

  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 3600) + 10_000_000n;

  // =================================================================== v3 ==
  section('v3: mint paying in ETH through the NonfungiblePositionManager');
  const [token0, token1] = weth.toLowerCase() < tkn.toLowerCase() ? [weth, tkn] : [tkn, weth];
  const tokenIsCurrency0 = token0 === tkn;
  // 1 ETH = 1,000 TKN.
  const startTick = tokenIsCurrency0 ? -69_060 : 69_060;
  const V3NPM = parseAbi([
    'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)',
    'function ownerOf(uint256) view returns (address)',
  ]);
  await send(deployer, npm, encodeFunctionData({ abi: V3NPM, functionName: 'createAndInitializePoolIfNecessary', args: [token0, token1, 3000, getSqrtRatioAtTick(startTick)] }));
  const v3Pool = (await pub.readContract({
    address: factory,
    abi: parseAbi(['function getPool(address,address,uint24) view returns (address)']),
    functionName: 'getPool',
    args: [token0, token1, 3000],
  })) as Address;
  const poolInfo = { address: v3Pool, token0, token1, fee: 3000, tickSpacing: 60, decimals0: 18, decimals1: 18 };

  const weth9 = await readV3Weth9(pub);
  check(weth9?.toLowerCase() === weth.toLowerCase(), 'the manager’s WETH9() is the wrapper the site knows');

  const slot = await readV3Slot0(pub, v3Pool);
  const plan3 = planV3Mint({
    pool: poolInfo,
    sqrtPriceX96: slot.sqrtPriceX96,
    tick: slot.tick,
    tokenIsCurrency0,
    depositQuote: parseEther('1'),
    minPct: -20,
    maxPct: 20,
    bins: 5,
    shape: 'curve',
    owner: user,
    slippageBps: 100,
    deadline: deadline(),
    payWithEtherFor: weth,
  });
  for (const step of await v3ApprovalsNeeded(pub, user, { token0, token1, amount0: plan3.amount0, amount1: plan3.amount1 }, weth)) {
    await spent(await approveV3(provider, user, step));
  }
  const ethBefore = await pub.getBalance({ address: user });
  const tknBefore = await balanceOf(tkn, user);
  const gas3 = await simulateV3Mint(pub, user, plan3);
  const mintHash = await sendV3Mint(provider, user, plan3, gas3);
  const minted3 = await waitForV3Mint(pub, mintHash, user);
  const mintGas = await spent(mintHash);
  check(minted3.ok && minted3.tokenIds.length === plan3.positions.length, `${minted3.tokenIds.length} v3 position NFTs minted to the wallet`);
  const ethPaid = ethBefore - (await pub.getBalance({ address: user })) - mintGas;
  const wethSide = tokenIsCurrency0 ? plan3.amount1 : plan3.amount0;
  check(ethPaid > 0n && ethPaid <= wethSide, `paid ${ethPaid} wei of ETH for a planned ${wethSide} (refundETH returned the rest)`);
  check((await holds(npm, [weth, tkn])) === 0n, 'the v3 manager holds no ETH, WETH or TKN after the mint');
  check(tknBefore - (await balanceOf(tkn, user)) <= (tokenIsCurrency0 ? plan3.amount0 : plan3.amount1), 'the token side took no more than planned');

  section('v3: fees from real swaps, read the way the portfolio reads them');
  const ROUTER = parseAbi([
    'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
    'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
  ]);
  for (const t of [weth, tkn]) await send(trader, t, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [router, 2n ** 255n] }));
  for (const [tokenIn, tokenOut, amountIn] of [
    [weth, tkn, parseEther('0.2')],
    [tkn, weth, parseEther('150')],
    [weth, tkn, parseEther('0.1')],
  ] as [Address, Address, bigint][]) {
    await send(trader, router, encodeFunctionData({
      abi: ROUTER,
      functionName: 'exactInputSingle',
      args: [{ tokenIn, tokenOut, fee: 3000, recipient: trader, deadline: deadline(), amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
    }));
  }
  const listed = await readV3Positions(pub, user);
  check(listed.length === minted3.tokenIds.length, `readV3Positions lists all ${listed.length} of the wallet’s v3 positions`);
  const fees3 = await readV3Fees(pub, user, listed.map((p) => p.tokenId));
  const feeTotal = [...fees3.values()].reduce((a, f) => a + f.fees0 + f.fees1, 0n);
  check(fees3.size === listed.length && feeTotal > 0n, `uncollected fees read from the chain: ${feeTotal} wei across both sides`);

  section('v3: collect, the ether side as ETH');
  const withFees = listed.find((p) => {
    const f = fees3.get(p.tokenId.toString())!;
    return f.fees0 > 0n && f.fees1 > 0n;
  })!;
  const f = fees3.get(withFees.tokenId.toString())!;
  const collect3 = planV3Collect({ tokenId: withFees.tokenId, token0, token1, owner: user, unwrap: weth9, expected0: f.fees0, expected1: f.fees1 });
  const eth0 = await pub.getBalance({ address: user });
  const tkn0 = await balanceOf(tkn, user);
  const collectHash = await flow.sendCall(provider, user, collect3, await flow.simulateCall(pub, user, collect3, npm), npm);
  const collectGas = await spent(collectHash);
  const ethGot = (await pub.getBalance({ address: user })) - eth0 + collectGas;
  const tknGot = (await balanceOf(tkn, user)) - tkn0;
  const [feeEth, feeTkn] = tokenIsCurrency0 ? [f.fees1, f.fees0] : [f.fees0, f.fees1];
  check(ethGot === feeEth, `received exactly the ${feeEth} wei of ether fees, as ETH`);
  check(tknGot === feeTkn, `received exactly the ${feeTkn} TKN fees`);
  check((await balanceOf(weth, user)) === 0n, 'no WETH arrived: the ether side was unwrapped');
  check((await holds(npm, [weth, tkn])) === 0n, 'the v3 manager holds nothing after the collect');

  section('v3: withdraw every position — in range and out of it — and burn the NFTs');
  let ethOut = 0n;
  let tknOut = 0n;
  for (const p of listed) {
    const now = await readV3Slot0(pub, v3Pool);
    const live = (await readV3Fees(pub, user, [p.tokenId])).get(p.tokenId.toString())!;
    const w = planV3Withdraw({
      tokenId: p.tokenId,
      token0,
      token1,
      owner: user,
      unwrap: weth9,
      sqrtPriceX96: now.sqrtPriceX96,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      liquidity: live.liquidity,
      owed0: live.fees0,
      owed1: live.fees1,
      slippageBps: 100,
      deadline: deadline(),
    });
    const e0 = await pub.getBalance({ address: user });
    const t0 = await balanceOf(tkn, user);
    const hash = await flow.sendCall(provider, user, w, await flow.simulateCall(pub, user, w, npm), npm);
    const g = await spent(hash);
    const e = (await pub.getBalance({ address: user })) - e0 + g;
    const t = (await balanceOf(tkn, user)) - t0;
    ethOut += e;
    tknOut += t;
    const [minEth, minTkn] = tokenIsCurrency0 ? [w.amount1Min, w.amount0Min] : [w.amount0Min, w.amount1Min];
    check(e >= minEth && t >= minTkn, `#${p.tokenId}: paid ${e} wei ETH and ${t} TKN, at or above the minimums`);
    const gone = await pub.readContract({ address: npm, abi: V3NPM, functionName: 'ownerOf', args: [p.tokenId] }).then(() => false, () => true);
    check(gone, `#${p.tokenId}: the NFT is burned`);
  }
  check((await readV3Positions(pub, user)).length === 0, 'the wallet holds no v3 positions afterwards');
  check((await holds(npm, [weth, tkn])) === 0n, 'the v3 manager holds nothing after every withdrawal');
  check((await balanceOf(weth, user)) === 0n, 'every ether side came back as ETH, not WETH');
  check(ethOut > 0n && tknOut > 0n, `withdrew ${ethOut} wei ETH and ${tknOut} TKN in total`);

  // =================================================================== v4 ==
  section('v4: mint with native ETH through PositionManager');
  const POOL_MANAGER = parseAbi([
    'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
    'function initialize(PoolKey key, uint160 sqrtPriceX96) returns (int24 tick)',
  ]);
  const key = { currency0: NATIVE_ETH as Address, currency1: tkn, fee: 3000, tickSpacing: 60, hooks: NATIVE_ETH as Address };
  // Native ether is always currency0; 1 ETH = 1,000 TKN.
  await send(deployer, poolManager, encodeFunctionData({ abi: POOL_MANAGER, functionName: 'initialize', args: [key, getSqrtRatioAtTick(69_060)] }));
  const s4 = await flow.readSlot0(pub, key);
  const plan4 = planMint({
    key,
    sqrtPriceX96: s4.sqrtPriceX96,
    tick: s4.tick,
    tokenIsCurrency0: false,
    depositQuote: parseEther('1'),
    minPct: -20,
    maxPct: 20,
    bins: 5,
    shape: 'curve',
    owner: user,
    slippageBps: 100,
    deadline: deadline(),
  });
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const step of await flow.approvalsNeeded(pub, user, key, plan4, nowSeconds)) {
    await spent(await flow.approve(provider, user, step, nowSeconds));
  }
  check((await flow.approvalsNeeded(pub, user, key, plan4, nowSeconds)).length === 0, 'Permit2 approvals in place (token → Permit2 → PositionManager)');
  const e4 = await pub.getBalance({ address: user });
  const mint4 = await flow.sendMint(provider, user, plan4, await flow.simulateMint(pub, user, plan4));
  const minted4 = await flow.waitForMint(pub, mint4, user);
  const g4 = await spent(mint4);
  check(minted4.ok && minted4.tokenIds.length === plan4.positions.length, `${minted4.tokenIds.length} v4 position NFTs minted to the wallet`);
  const paid4 = e4 - (await pub.getBalance({ address: user })) - g4;
  check(paid4 > 0n && paid4 <= plan4.amount0 + BigInt(plan4.positions.length), `paid ${paid4} wei for a planned ${plan4.amount0} (SWEEP returned the rest)`);
  check((await holds(posm, [tkn, weth])) === 0n, 'PositionManager holds nothing after the mint');

  section('v4: the portfolio finds and confirms the positions on chain');
  const next = await readNextTokenId(pub);
  const owners = await readOwners(pub, 1n, next);
  const mine = [...owners.entries()].filter(([, o]) => o === user.toLowerCase()).map(([id]) => id);
  check(mine.length === minted4.tokenIds.length, `the id scan finds all ${mine.length} of the wallet’s v4 NFTs`);
  const read4 = await readV4Positions(pub, user, [...mine, 999n]);
  check(read4.positions.length === mine.length && read4.unconfirmed === 0, 'every one confirmed: the packed PositionInfo decodes to a range StateView agrees with');
  for (const p of read4.positions) {
    const planned = plan4.positions.find((q) => q.tickLower === p.tickLower && q.tickUpper === p.tickUpper);
    check(planned !== undefined && planned.liquidity === p.liquidity, `#${p.tokenId}: range ${p.tickLower}…${p.tickUpper} and liquidity match what was minted`);
  }
  check((await readV4Positions(pub, trader, mine)).positions.length === 0, 'another wallet is shown none of them');

  section('v4: fees from real swaps, then collect');
  const SWAP_TEST = parseAbi([
    'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
    'struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }',
    'struct TestSettings { bool takeClaims; bool settleUsingBurn; }',
    'function swap(PoolKey key, SwapParams params, TestSettings testSettings, bytes hookData) payable returns (int256)',
  ]);
  await send(trader, tkn, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [swapTest, 2n ** 255n] }));
  const MIN_LIMIT = 4295128739n + 1n;
  const MAX_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
  for (const [zeroForOne, amount, value] of [
    [true, parseEther('0.2'), parseEther('0.2')],
    [false, parseEther('150'), 0n],
  ] as [boolean, bigint, bigint][]) {
    await send(trader, swapTest, encodeFunctionData({
      abi: SWAP_TEST,
      functionName: 'swap',
      args: [key, { zeroForOne, amountSpecified: -amount, sqrtPriceLimitX96: zeroForOne ? MIN_LIMIT : MAX_LIMIT }, { takeClaims: false, settleUsingBurn: false }, '0x'],
    }), value);
  }
  const queries = read4.positions.map((p) => ({ tokenId: p.tokenId, key, tickLower: p.tickLower, tickUpper: p.tickUpper }));
  const fees4 = await readPositionFees(pub, queries);
  const earning = read4.positions.find((p) => {
    const x = fees4.get(p.tokenId.toString())!;
    return x.fees0 > 0n && x.fees1 > 0n;
  })!;
  const ef = fees4.get(earning.tokenId.toString())!;
  check(ef !== undefined, `fees read from StateView: ${ef.fees0} wei ETH, ${ef.fees1} TKN on #${earning.tokenId}`);
  const c4 = planCollect({ key, tokenId: earning.tokenId, owner: user, deadline: deadline() });
  const ce = await pub.getBalance({ address: user });
  const ct = await balanceOf(tkn, user);
  const ch = await flow.sendCall(provider, user, c4, await flow.simulateCall(pub, user, c4));
  const cg = await spent(ch);
  check((await pub.getBalance({ address: user })) - ce + cg === ef.fees0, 'collected exactly the ether fees StateView reported, as ETH');
  check((await balanceOf(tkn, user)) - ct === ef.fees1, 'collected exactly the TKN fees StateView reported');
  check((await holds(posm, [tkn, weth])) === 0n, 'PositionManager holds nothing after the collect');

  section('v4: the withdrawal guard refuses a price that moved too far');
  {
    const p = read4.positions[0];
    const before = await flow.readSlot0(pub, key);
    const liq = (await readPositionFees(pub, [{ tokenId: p.tokenId, key, tickLower: p.tickLower, tickUpper: p.tickUpper }])).get(p.tokenId.toString())!.liquidity;
    const mins = burnAmountsWithSlippage({ sqrtPriceX96: before.sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: liq, slippageBps: 100n });
    const stale = planWithdraw({ key, tokenId: p.tokenId, owner: user, amount0: mins.amount0, amount1: mins.amount1, slippageBps: 0, deadline: deadline() });
    // A large trade moves the price well past 1% before the withdrawal lands.
    await send(trader, swapTest, encodeFunctionData({
      abi: SWAP_TEST,
      functionName: 'swap',
      args: [key, { zeroForOne: true, amountSpecified: -parseEther('3'), sqrtPriceLimitX96: MIN_LIMIT }, { takeClaims: false, settleUsingBurn: false }, '0x'],
    }), parseEther('3'));
    const refused = await flow.simulateCall(pub, user, stale).then(() => null, (e: unknown) => e);
    check(refused !== null, 'the stale withdrawal is refused by the node before any signature');
    const said = refused ? flow.describeTxError(refused) : '';
    check(/price moved/.test(said), `and the page says why, in words: “${said}”`);
    check((await readV4Positions(pub, user, [p.tokenId])).positions.length === 1, 'and the position is untouched');
  }

  section('v4: withdraw every position and burn the NFTs');
  let out0 = 0n;
  let out1 = 0n;
  for (const p of read4.positions) {
    const now = await flow.readSlot0(pub, key);
    const liq = (await readPositionFees(pub, [{ tokenId: p.tokenId, key, tickLower: p.tickLower, tickUpper: p.tickUpper }])).get(p.tokenId.toString())!.liquidity;
    const mins = burnAmountsWithSlippage({ sqrtPriceX96: now.sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: liq, slippageBps: 100n });
    const w = planWithdraw({ key, tokenId: p.tokenId, owner: user, amount0: mins.amount0, amount1: mins.amount1, slippageBps: 0, deadline: deadline() });
    const e0 = await pub.getBalance({ address: user });
    const t0 = await balanceOf(tkn, user);
    const g = await spent(await flow.sendCall(provider, user, w, await flow.simulateCall(pub, user, w)));
    const got0 = (await pub.getBalance({ address: user })) - e0 + g;
    const got1 = (await balanceOf(tkn, user)) - t0;
    out0 += got0;
    out1 += got1;
    check(got0 >= mins.amount0 && got1 >= mins.amount1, `#${p.tokenId}: paid ${got0} wei ETH and ${got1} TKN, at or above the minimums`);
  }
  check((await readV4Positions(pub, user, mine)).positions.length === 0, 'every NFT burned: the portfolio would list none');
  check((await holds(posm, [tkn, weth])) === 0n, 'PositionManager holds nothing after every withdrawal');
  check(out0 > 0n && out1 > 0n, `withdrew ${out0} wei ETH and ${out1} TKN in total`);

  section('v4: a pool quoted in the wrapper, entered with ETH (wrap, then mint)');
  {
    const [c0, c1] = weth.toLowerCase() < tkn.toLowerCase() ? [weth, tkn] : [tkn, weth];
    const wkey = { currency0: c0, currency1: c1, fee: 500, tickSpacing: 10, hooks: NATIVE_ETH as Address };
    const tokenFirst = c0 === tkn;
    await send(deployer, poolManager, encodeFunctionData({ abi: POOL_MANAGER, functionName: 'initialize', args: [wkey, getSqrtRatioAtTick(tokenFirst ? -69_060 : 69_060)] }));
    const ws = await flow.readSlot0(pub, wkey);
    const wp = planMint({ key: wkey, sqrtPriceX96: ws.sqrtPriceX96, tick: ws.tick, tokenIsCurrency0: tokenFirst, depositQuote: parseEther('0.5'), minPct: -10, maxPct: 10, bins: 7, shape: 'spot', owner: user, slippageBps: 100, deadline: deadline() });
    const needsQuote = tokenFirst ? wp.amount1 : wp.amount0;
    const shortfall = flow.wrapShortfall({
      planned: needsQuote,
      cap: tokenFirst ? wp.amount1Max : wp.amount0Max,
      positions: wp.positions.length,
      wrappedBalance: await balanceOf(weth, user),
      nativeBalance: await pub.getBalance({ address: user }),
      reserve: 10n ** 15n,
    });
    check(shortfall !== null && shortfall > needsQuote, `wraps ${shortfall} wei, above the planned ${needsQuote}`);
    await spent(await flow.sendWrap(provider, user, shortfall!, await flow.simulateWrap(pub, user, shortfall!)));
    for (const step of await flow.approvalsNeeded(pub, user, wkey, wp, nowSeconds)) await spent(await flow.approve(provider, user, step, nowSeconds));
    const mh = await flow.sendMint(provider, user, wp, await flow.simulateMint(pub, user, wp));
    const mw = await flow.waitForMint(pub, mh, user);
    check(mw.ok && mw.tokenIds.length === wp.positions.length, `${mw.tokenIds.length} positions minted into the wrapped-ether pool`);
    check((await holds(posm, [tkn, weth])) === 0n, 'PositionManager holds nothing after it');

    section('the portfolio API’s own chain reader, against the same node');
    // One more v3 position, so both managers hold something to be found.
    const s3 = await readV3Slot0(pub, v3Pool);
    const one = planV3Mint({ pool: poolInfo, sqrtPriceX96: s3.sqrtPriceX96, tick: s3.tick, tokenIsCurrency0, depositQuote: parseEther('0.1'), minPct: 0, maxPct: 0, bins: 1, shape: 'spot', fullRange: true, owner: user, slippageBps: 100, deadline: deadline(), payWithEtherFor: weth });
    await spent(await sendV3Mint(provider, user, one, await simulateV3Mint(pub, user, one)));
    process.env.RPC_URLS = RPC;
    const { chainPortfolioReader } = await import('../api/chain-portfolio');
    const reader = chainPortfolioReader();
    const v3Found = await reader.v3Positions(user);
    check(v3Found.length === 1 && v3Found[0].liquidity > 0n, 'v3Positions enumerates the wallet’s one open v3 position');
    const v4Found = await reader.v4Positions(user, mw.tokenIds);
    check(v4Found.positions.length === mw.tokenIds.length && v4Found.unconfirmed === 0, `v4Positions confirms all ${mw.tokenIds.length} v4 positions`);
    const refs = [
      { id: `v3:${v3Pool.toLowerCase()}`, protocol: 'v3' as const, address: v3Pool, key: { currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks: NATIVE_ETH as Address } },
      { id: 'v4:wrapped', protocol: 'v4' as const, address: '', key: wkey },
    ];
    const prices = await reader.slot0s(refs);
    check(prices.get(refs[0].id)?.tick === (await readV3Slot0(pub, v3Pool)).tick, 'slot0s reads the v3 pool’s price');
    check(prices.get('v4:wrapped')?.tick === (await flow.readSlot0(pub, wkey)).tick, 'slot0s reads the v4 pool’s price through StateView');
    const found = await reader.v3PoolAddresses([{ token0, token1, fee: 3000 }, { token0, token1, fee: 500 }]);
    check(found.get(`${token0.toLowerCase()}|${token1.toLowerCase()}|3000`) === v3Pool.toLowerCase(), 'v3PoolAddresses finds the pool on the factory');
    check(/^0x0{40}$/.test(found.get(`${token0.toLowerCase()}|${token1.toLowerCase()}|500`) ?? ''), 'and answers zero for a pool that does not exist');
    const meta = await reader.tokens([tkn, '0x000000000000000000000000000000000000dEaD']);
    check(meta.get(tkn.toLowerCase())?.symbol === 'TKN' && meta.get(tkn.toLowerCase())?.decimals === 18, 'tokens reads a token’s own symbol and decimals');
    check(!meta.has('0x000000000000000000000000000000000000dead'), 'and leaves out an address that will not state its decimals');
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
