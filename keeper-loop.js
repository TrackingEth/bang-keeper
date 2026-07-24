// $BANG autonomous keeper — LOOP variant (drains the WHOLE pot each run).
// ─────────────────────────────────────────────────────────────────────────────
// LOCAL / TEST build — NOT deployed, NOT pushed. Identical to keeper.js except the
// single buyAll is wrapped in a loop: it keeps calling buyAll (each capped at
// maxSpendPerCall per asset -> small, good fills) while waiting out the on-chain
// buyCooldown, until the treasury pot is drained below MIN_POT_ETH, then pushes the
// rewards to holders ONCE. This keeps the hourly cron cadence (one run/hour) but
// makes that single run distribute EVERYTHING collected that hour, in small chunks.
//
// Why a loop (not a bigger buy): maxSpendPerCall is frozen at 0.01 ETH by the
// immutable maxSpendHardCap, on purpose (shallow MSFT/AMZN/META pools clear cleanly
// at that cap). Looping many small capped buys drains the pot without worsening
// slippage — each individual fill stays as good as it is today.
//
// DRY_RUN=1 -> simulate via callStatic and send NOTHING (safe to run vs live mainnet).
const { ethers } = require("ethers");

const RPC = process.env.RPC || "https://rpc.mainnet.chain.robinhood.com";
const KEEPER_PK = process.env.KEEPER_PK; // GitHub secret — throwaway EOA, NEVER the owner/curator key
const DRY_RUN = !!process.env.DRY_RUN;   // read-only simulation: no txs are sent

const TREASURY = process.env.TREASURY || "0xABCddE3aedd411C048194db987c19BBF33325CaF";
const TOKEN = process.env.TOKEN || "0xABCdEF96793d3F2c06c7e3b5bf73c7D4Bd665F95";
const DISTRIBUTOR = process.env.DISTRIBUTOR || "0x6edd4DBb53Cb2718e6C669e43ba2F0811f548136";
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

// MIN_POT_ETH is the TRIGGER: below it the run does nothing at all (no buys, no push),
// so the fixed gas cost of a distribution is only paid once the pot is worth distributing.
// DRAIN_TO_ETH is the FLOOR: once a run has triggered, it drains the pot down to here
// instead of stopping at the trigger, which would park a residue in the treasury forever.
const MIN_POT_ETH = ethers.parseEther(process.env.MIN_POT_ETH || "0.02");
const DRAIN_TO_ETH_RAW = ethers.parseEther(process.env.DRAIN_TO_ETH || "0.002");
const DRAIN_TO_ETH = DRAIN_TO_ETH_RAW < MIN_POT_ETH ? DRAIN_TO_ETH_RAW : MIN_POT_ETH;
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS || "1500"); // minOut = 85% of spot estimate
const PROCESS_GAS = BigInt(process.env.PROCESS_GAS || "900000"); // gas budget per round-robin push call
const RECYCLE_AT = ethers.parseEther(process.env.RECYCLE_AT || "1");
const KEEP_GAS = ethers.parseEther(process.env.KEEP_GAS || "0.1");

// ---- LOOP knobs (bound the run so it never overruns the CI timeout) ----
const MAX_BUYALLS_PER_RUN = Number(process.env.MAX_BUYALLS_PER_RUN || 8); // hard ceiling on buys per run
const MAX_RUN_SECONDS = Number(process.env.MAX_RUN_SECONDS || 1500);      // ~25min budget; the push still runs after
const COOLDOWN_BUFFER = Number(process.env.COOLDOWN_BUFFER || 5);         // secs added to each cooldown wait

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const treasuryAbi = [
  "function buyAll(uint256[] minOuts) returns (uint256,uint256[],uint256[])",
  "function assetCount() view returns (uint256)",
  "function lastBuyAt() view returns (uint256)",
  "function buyCooldown() view returns (uint256)",
  "function maxSpendPerCall() view returns (uint256)",
];
const tokenAbi = ["function processRewardClaims(uint256 gasLimit) returns (uint256,uint256,uint256)"];
const distAbi = [
  "function holderCount() view returns (uint256)",
  "event Processed(uint256 iterations, uint256 claims, uint256 lastProcessedIndex, uint256 gasLimit, address indexed executor)",
];
const svAbi = ["function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24, uint24, uint24)"];
const coder = ethers.AbiCoder.defaultAbiCoder();
const poolId = (c1) => ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], [ethers.ZeroAddress, c1, FEE, TICK_SPACING, HOOKS]));

// mirror the contract's per-asset spend, then derive a sane minOut per asset from the pool's spot price
async function computeMinOuts(sv, per) {
  const minOuts = [];
  for (let i = 0; i < STOCKS.length; i++) {
    let minOut = 1n;
    try {
      const s0 = await sv.getSlot0(poolId(STOCKS[i]));
      const sp = BigInt(s0.sqrtPriceX96);
      const expected = (per * sp * sp) >> 192n; // ~ per * (sqrtPrice/2^96)^2
      minOut = (expected * (10000n - SLIPPAGE_BPS)) / 10000n;
      if (minOut < 1n) minOut = 1n;
    } catch (e) {
      minOut = ethers.MaxUint256; // feed read failed -> force a SAFE SKIP (buyAll's per-asset try/catch skips it)
    }
    minOuts.push(minOut);
  }
  return minOuts;
}

async function main() {
  if (!KEEPER_PK && !DRY_RUN) throw new Error("set KEEPER_PK (a throwaway EOA private key)");
  const p = new ethers.JsonRpcProvider(RPC);
  const w = KEEPER_PK ? new ethers.Wallet(KEEPER_PK, p) : null;
  const runner = w || p;
  const treasury = new ethers.Contract(TREASURY, treasuryAbi, runner);
  const token = new ethers.Contract(TOKEN, tokenAbi, runner);
  const distributor = new ethers.Contract(DISTRIBUTOR, distAbi, p);
  const sv = new ethers.Contract(STATEVIEW, svAbi, p);
  console.log(`keeper-loop — from=${w ? w.address : "(dry-run)"} dryRun=${DRY_RUN} maxBuys=${MAX_BUYALLS_PER_RUN}`);

  const maxSpend = await treasury.maxSpendPerCall();
  const n = Number(await treasury.assetCount());
  const start = Date.now();
  const elapsed = () => (Date.now() - start) / 1000;

  // ---- BUY LOOP: drain the pot in small capped buys, waiting out the cooldown between each ----
  let buys = 0;
  while (buys < MAX_BUYALLS_PER_RUN) {
    if (elapsed() > MAX_RUN_SECONDS) { console.log("run time budget hit — stopping buy loop, moving to push"); break; }
    const pot = await p.getBalance(TREASURY);
    console.log(`[buy ${buys}] pot=${ethers.formatEther(pot)} ETH`);
    // first pass must clear the trigger; after that we drain to the lower floor
    const floor = buys === 0 ? MIN_POT_ETH : DRAIN_TO_ETH;
    if (pot < floor) {
      console.log(buys === 0
        ? `pot below MIN_POT_ETH (${ethers.formatEther(MIN_POT_ETH)}) — not worth a distribution yet, idling`
        : `pot below DRAIN_TO_ETH (${ethers.formatEther(DRAIN_TO_ETH)}) — fully drained, stopping loop`);
      break;
    }
    if (n !== STOCKS.length) { console.log(`assetCount=${n} != 8 — abort`); break; }

    // respect the on-chain cooldown (buyAll reverts CooldownActive otherwise)
    const [lastBuyAt, cd, blk] = await Promise.all([treasury.lastBuyAt(), treasury.buyCooldown(), p.getBlock("latest")]);
    const remain = Number(lastBuyAt) + Number(cd) - blk.timestamp;
    if (remain > 0) {
      if (elapsed() + remain > MAX_RUN_SECONDS) { console.log(`cooldown ${remain}s would exceed budget — stopping`); break; }
      console.log(`cooldown ${remain}s — waiting...`);
      if (!DRY_RUN) await sleep((remain + COOLDOWN_BUFFER) * 1000);
    }

    let per = (pot * 9900n) / (10000n * BigInt(STOCKS.length));
    if (per > maxSpend) per = maxSpend;
    const minOuts = await computeMinOuts(sv, per);

    try {
      if (DRY_RUN) {
        const res = await treasury.buyAll.staticCall(minOuts);
        console.log(`[dry] buyAll would succeed — spentTotal~${ethers.formatEther(res[0] ?? 0n)} ETH (per=${ethers.formatEther(per)})`);
        buys++;
        console.log("[dry] cannot advance chain time locally — stopping after 1 simulated buy (loop proven on fork test)");
        break;
      }
      const tx = await treasury.buyAll(minOuts);
      const rc = await tx.wait();
      console.log(`buyAll ok: ${tx.hash} (block ${rc.blockNumber})`);
      buys++;
    } catch (e) {
      console.log("buyAll skipped/failed:", e.shortMessage || e.message, "— stopping loop");
      break;
    }
  }
  console.log(`buy loop done: ${buys} buyAll(s) in ${Math.round(elapsed())}s`);

  // ---- PUSH ONCE: cover every holder exactly one lap of the ring, then stop ----
  // distributor.process() already caps itself at `iterations < numberOfHolders`, so one
  // lap is all it takes to offer every holder a payment. The old fixed pass count kept
  // calling past that: measured on mainnet, the tail passes iterated 19 holders each for
  // ZERO claims at ~900k gas apiece, and that waste was 97% of the keeper's whole gas bill.
  // Summing the Processed event's `iterations` tells us exactly when the lap closes.
  if (buys === 0) {
    console.log("no buys this run — nothing new to distribute, skipping push");
  } else {
    try {
      const holderCount = Number(await distributor.holderCount());
      const cap = Number(process.env.PUSH_MAX_PASSES || 80);
      if (DRY_RUN) {
        console.log(`[dry] would push until one lap of ${holderCount} holders is covered (cap ${cap} passes)`);
      } else {
        let covered = 0, claims = 0, passes = 0;
        while (covered < holderCount && passes < cap) {
          const rc = await (await token.processRewardClaims(PROCESS_GAS)).wait();
          passes++;
          const ev = rc.logs
            .map((l) => { try { return distributor.interface.parseLog(l); } catch (_) { return null; } })
            .find((e) => e && e.name === "Processed");
          if (!ev) { console.log("push: no Processed event in receipt — stopping"); break; }
          const it = Number(ev.args.iterations);
          covered += it;
          claims += Number(ev.args.claims);
          if (it === 0) break; // empty ring — nothing left to walk
        }
        console.log(`processRewardClaims: ${passes} passes, ${covered}/${holderCount} holders covered, ${claims} paid`);
      }
    } catch (e) { console.log("processRewardClaims:", e.shortMessage || e.message); }
  }

  // ---- RECYCLE: keeper never hoards its 1% (unchanged from keeper.js) ----
  if (!DRY_RUN && w) {
    const myBal = await p.getBalance(w.address);
    if (myBal > RECYCLE_AT) {
      const giveBack = myBal - KEEP_GAS;
      try {
        const tx = await w.sendTransaction({ to: TREASURY, value: giveBack });
        await tx.wait();
        console.log(`recycled ${ethers.formatEther(giveBack)} ETH -> treasury; kept ~${ethers.formatEther(KEEP_GAS)} for gas`);
      } catch (e) { console.log("recycle:", e.shortMessage || e.message); }
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("KEEPER ERROR:", e.message); process.exit(1); });
