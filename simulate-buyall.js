// READ-ONLY simulation. Never touches KEEPER_PK — only the RPC secret. Cannot send a
// transaction even if it wanted to: the contract is connected to a bare Provider, no Signer.
// Mirrors keeper-loop.js's own quoting logic exactly (StateView.getSlot0 spot price, same
// SLIPPAGE_BPS), then staticCall's buyAll to see the REAL outcome against current chain state.
const { ethers } = require("ethers");

const RPC = process.env.RPC || "https://rpc.mainnet.chain.robinhood.com";
const TREASURY = process.env.TREASURY || "0xABCddE3aedd411C048194db987c19BBF33325CaF";
const STATEVIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";

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
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS || "1500");

const treasuryAbi = [
  "function buyAll(uint256[] minOuts) returns (uint256,uint256[],uint256[])",
  "function assetCount() view returns (uint256)",
  "function lastBuyAt() view returns (uint256)",
  "function buyCooldown() view returns (uint256)",
  "function maxSpendPerCall() view returns (uint256)",
];
const svAbi = ["function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24, uint24, uint24)"];
const coder = ethers.AbiCoder.defaultAbiCoder();
const poolId = (c1) => ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], [ethers.ZeroAddress, c1, FEE, TICK_SPACING, HOOKS]));

async function computeMinOuts(sv, per) {
  const minOuts = [];
  for (let i = 0; i < STOCKS.length; i++) {
    let minOut = 1n;
    try {
      const s0 = await sv.getSlot0(poolId(STOCKS[i]));
      const sp = BigInt(s0.sqrtPriceX96);
      const expected = (per * sp * sp) >> 192n;
      minOut = (expected * (10000n - SLIPPAGE_BPS)) / 10000n;
      if (minOut < 1n) minOut = 1n;
    } catch (e) {
      minOut = ethers.MaxUint256;
    }
    minOuts.push(minOut);
  }
  return minOuts;
}

async function main() {
  const p = new ethers.JsonRpcProvider(RPC); // read-only: no wallet, no signer, cannot broadcast
  const treasury = new ethers.Contract(TREASURY, treasuryAbi, p);
  const sv = new ethers.Contract(STATEVIEW, svAbi, p);

  const pot = await p.getBalance(TREASURY);
  const [lastBuyAt, cooldown, maxSpend, n, blk] = await Promise.all([
    treasury.lastBuyAt(), treasury.buyCooldown(), treasury.maxSpendPerCall(), treasury.assetCount(), p.getBlock("latest"),
  ]);
  const cooldownRemaining = Number(lastBuyAt) + Number(cooldown) - blk.timestamp;
  console.log(`[sim] treasury=${TREASURY} pot=${ethers.formatEther(pot)} ETH assetCount=${n} cooldownRemaining=${cooldownRemaining}s`);

  if (Number(n) !== STOCKS.length) {
    console.log(`[sim] ABORT: assetCount ${n} != expected ${STOCKS.length}`);
    return;
  }

  let per = (pot * 9900n) / (10000n * BigInt(STOCKS.length));
  if (per > maxSpend) per = maxSpend;
  console.log(`[sim] per-asset spend = ${ethers.formatEther(per)} ETH (maxSpendPerCall=${ethers.formatEther(maxSpend)} ETH)`);

  const minOuts = await computeMinOuts(sv, per);
  minOuts.forEach((m, i) => console.log(`[sim] asset ${i} minOut=${m === ethers.MaxUint256 ? "MAX(forced skip)" : ethers.formatUnits(m)}`));

  try {
    const [spentTotal, rewardOuts, burnedOuts] = await treasury.buyAll.staticCall(minOuts);
    console.log(`[sim] RESULT: buyAll WOULD SUCCEED — spentTotal=${ethers.formatEther(spentTotal)} ETH`);
    for (let i = 0; i < STOCKS.length; i++) {
      console.log(`[sim]   asset ${i}: rewardOut=${ethers.formatUnits(rewardOuts[i])} burnedOut=${ethers.formatUnits(burnedOuts[i])}`);
    }
  } catch (e) {
    console.log(`[sim] RESULT: buyAll WOULD REVERT — ${e.shortMessage || e.message}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("SIM ERROR:", e.message); process.exit(1); });
