// Daily BlackBerry burn. Sweeps the 0.663% LP fee out of the pool and buys+burns $BB.
// Runs from GitHub Actions once a day. Caller must be the launcher `authority` OR a registered keeper
// (treasury.isKeeper == true) — our throwaway keeper is registered via setup-keeper.js.
const { ethers } = require("ethers");

const RPC = process.env.RPC || "https://rpc.mainnet.chain.robinhood.com";
const KEEPER_PK = process.env.KEEPER_PK; // GitHub secret — a throwaway EOA, NEVER the owner/curator key
const LAUNCHER = process.env.LAUNCHER || "0x9F6c8A43772F262AcF59eabb3431897A87A31E4d";

// minBBOut = 0: collectLpFees is keeper-gated (not a public function), the daily LP fee is tiny, and the
// Robinhood chain has no meaningful public MEV mempool — a sandwich on this would net dust and cost gas.
// If BB liquidity ever grows enough to be worth protecting, swap this for a spot-priced floor.
const MIN_BB_OUT = BigInt(process.env.MIN_BB_OUT || "0");

const launcherAbi = ["function collectLpFees(uint256 minBBOut)"];

async function main() {
  if (!KEEPER_PK) throw new Error("set KEEPER_PK (a throwaway EOA private key)");
  const p = new ethers.JsonRpcProvider(RPC);
  const w = new ethers.Wallet(KEEPER_PK, p);
  const launcher = new ethers.Contract(LAUNCHER, launcherAbi, w);
  console.log(`burn-bb: keeper=${w.address} balance=${ethers.formatEther(await p.getBalance(w.address))} ETH`);
  try {
    const tx = await launcher.collectLpFees(MIN_BB_OUT);
    const rc = await tx.wait();
    console.log(`collectLpFees ok: ${tx.hash} (block ${rc.blockNumber}) — LP fee swept, BlackBerry bought & burned`);
  } catch (e) {
    console.log("collectLpFees skipped/failed:", e.shortMessage || e.message); // e.g. no fee accrued yet
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("BURN ERROR:", e.message); process.exit(1); });
