// $BANG autonomous keeper — permissionless. Anyone can run this; it earns 1% (KEEPER_BPS) of each round,
// which self-funds its gas. No privileged key needed: the wallet below is a throwaway EOA, not the owner.
// It (1) drives buyAll (buys the 8 stocks + credits holders) and (2) pushes rewards to holders' wallets.
// Runs on a schedule (GitHub Actions cron). Survives the founder — anyone/any bot can run it for the reward.
const { ethers } = require("ethers");

const RPC = process.env.RPC || "https://rpc.mainnet.chain.robinhood.com";
const KEEPER_PK = process.env.KEEPER_PK; // GitHub secret — a dedicated throwaway EOA, NEVER the owner/curator key

// ---- FINAL $BANG addresses (fill TREASURY/TOKEN after the real launch; they are the pre-mined vanity targets) ----
const TREASURY = process.env.TREASURY || "0xABCddE3aedd411C048194db987c19BBF33325CaF";
const TOKEN = process.env.TOKEN || "0xABCdEF96793d3F2c06c7e3b5bf73c7D4Bd665F95";
const STATEVIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";

// 8 stock pools (V4 native-ETH, fee 50000, tickSpacing 1000, no hook) — order MUST match the on-chain basket 0..7
const STOCKS = [
  "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9", // 0 AAPL
  "0xe93237c50d904957cf27e7b1133b510c669c2e74", // 1 MSFT
  "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3", // 2 GOOGL
  "0x12f190a9f9d7d37a250758b26824b97ce941bf54", // 3 AMZN
  "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", // 4 NVDA
  "0xc0d6457c16cc70d6790dd43521c899c87ce02f35", // 5 META
  "0x322f0929c4625ed5bad873c95208d54e1c003b2d", // 6 TSLA
  "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea", // 7 SPCX
];
const FEE = 50000, TICK_SPACING = 1000, HOOKS = ethers.ZeroAddress;

// Only fire buyAll when the treasury has accumulated enough that the round is worth the gas (self-regulating).
const MIN_POT_ETH = ethers.parseEther(process.env.MIN_POT_ETH || "0.02");
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS || "1500"); // minOut = 85% of spot estimate (covers 5% pool fee + impact)
const PROCESS_GAS = BigInt(process.env.PROCESS_GAS || "900000"); // gas budget for the round-robin auto-claim push
const RECYCLE_AT = ethers.parseEther(process.env.RECYCLE_AT || "1");   // when the keeper's OWN balance passes this...
const KEEP_GAS = ethers.parseEther(process.env.KEEP_GAS || "0.1");     // ...it keeps 0.1 for gas (~a month runway) and sends the rest (~0.9) back to the treasury (-> next buyAll -> stocks to holders)

const treasuryAbi = [
  "function buyAll(uint256[] minOuts) returns (uint256,uint256[],uint256[])",
  "function assetCount() view returns (uint256)",
  "function lastBuyAt() view returns (uint256)",
  "function buyCooldown() view returns (uint256)",
  "function maxSpendPerCall() view returns (uint256)",
];
const tokenAbi = ["function processRewardClaims(uint256 gasLimit) returns (uint256,uint256,uint256)"];
const distAbi = ["function holderCount() view returns (uint256)"];
const DISTRIBUTOR = process.env.DISTRIBUTOR || "0x6edd4DBb53Cb2718e6C669e43ba2F0811f548136";
const svAbi = ["function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24, uint24, uint24)"];
const coder = ethers.AbiCoder.defaultAbiCoder();
const poolId = (c1) => ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], [ethers.ZeroAddress, c1, FEE, TICK_SPACING, HOOKS]));

async function main() {
  if (!KEEPER_PK) throw new Error("set KEEPER_PK (a throwaway EOA private key)");
  const p = new ethers.JsonRpcProvider(RPC);
  const w = new ethers.Wallet(KEEPER_PK, p);
  const treasury = new ethers.Contract(TREASURY, treasuryAbi, w);
  const token = new ethers.Contract(TOKEN, tokenAbi, w);
  const distributor = new ethers.Contract(DISTRIBUTOR, distAbi, p);
  const sv = new ethers.Contract(STATEVIEW, svAbi, p);

  const pot = await p.getBalance(TREASURY);
  const now = Math.floor(Date.now() / 1000); // note: only for a local log; the contract enforces the real cooldown
  const [lastBuyAt, cooldown, maxSpend, n] = await Promise.all([
    treasury.lastBuyAt(), treasury.buyCooldown(), treasury.maxSpendPerCall(), treasury.assetCount(),
  ]);
  console.log(`treasury pot=${ethers.formatEther(pot)} ETH  lastBuyAt=${lastBuyAt}  cooldown=${cooldown}s  keeper=${w.address}`);

  const cooldownOk = BigInt(now) >= lastBuyAt + cooldown;
  if (pot >= MIN_POT_ETH && cooldownOk && Number(n) === STOCKS.length) {
    // per-asset spend the contract will use (99% of pot / N, capped) — mirror it to compute a sane minOut
    let per = (pot * 9900n) / (10000n * BigInt(STOCKS.length));
    if (per > maxSpend) per = maxSpend;
    const minOuts = [];
    for (let i = 0; i < STOCKS.length; i++) {
      let minOut = 1n;
      try {
        const s0 = await sv.getSlot0(poolId(STOCKS[i]));
        const sp = BigInt(s0.sqrtPriceX96);
        // expected stock out (wei) ~= per * (sqrtPrice/2^96)^2  (ETH & stock both 18-dec)
        const expected = (per * sp * sp) >> 192n;
        minOut = (expected * (10000n - SLIPPAGE_BPS)) / 10000n;
        if (minOut < 1n) minOut = 1n;
      } catch (e) { minOut = ethers.MaxUint256; } // feed read failed -> force a SAFE SKIP (buyOne reverts Slippage, buyAll's per-asset try/catch skips it). NEVER minOut=1: that removes all slippage protection and invites a full sandwich.
      minOuts.push(minOut);
    }
    try {
      const tx = await treasury.buyAll(minOuts);
      const rc = await tx.wait();
      console.log(`buyAll ok: ${tx.hash} (block ${rc.blockNumber}) — earned ~1% of the round`);
    } catch (e) { console.log("buyAll skipped/failed:", e.shortMessage || e.message); }
  } else {
    console.log(`buyAll not due (pot<${ethers.formatEther(MIN_POT_ETH)} or cooldown active) — accumulating`);
  }

  // push accrued rewards to ALL holders. The round-robin does ~2 holders per call, so loop enough
  // passes to cover a full holder-cycle each run (bounded; cheap once everyone is caught up).
  try {
    const holderCount = Number(await distributor.holderCount());
    const passes = Math.min(Math.ceil(holderCount / 2) + 2, Number(process.env.PUSH_MAX_PASSES || 80));
    for (let i = 0; i < passes; i++) {
      await (await token.processRewardClaims(PROCESS_GAS)).wait();
    }
    console.log(`processRewardClaims: ${passes} passes covering ${holderCount} holders`);
  } catch (e) { console.log("processRewardClaims:", e.shortMessage || e.message); }

  // recycle: the keeper does NOT hoard its 1% rewards. Once its own balance passes RECYCLE_AT (1 ETH),
  // it keeps at most KEEP_GAS (0.005) for gas and sends the rest back to the treasury, where the next
  // buyAll turns it into stocks airdropped to holders. Between recycles the balance stays well above the
  // floor, so gas is never short; the floor is only momentary right after a recycle.
  const myBal = await p.getBalance(w.address);
  if (myBal > RECYCLE_AT) {
    const giveBack = myBal - KEEP_GAS;
    try {
      const tx = await w.sendTransaction({ to: TREASURY, value: giveBack });
      await tx.wait();
      console.log(`recycled ${ethers.formatEther(giveBack)} ETH -> treasury (becomes stock airdrops next round); kept ~${ethers.formatEther(KEEP_GAS)} for gas`);
    } catch (e) { console.log("recycle:", e.shortMessage || e.message); }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("KEEPER ERROR:", e.message); process.exit(1); });
