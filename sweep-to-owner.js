// ONE-OFF: sweep the keeper's ENTIRE remaining ETH balance to Pedro's personal wallet.
// Used only for the final wind-down of $BANG (no more volume, retiring the keeper for good).
// Run manually via workflow_dispatch — NOT on a schedule, NOT part of the recurring keeper.
const { ethers } = require("ethers");

const RPC = process.env.RPC || "https://rpc.mainnet.chain.robinhood.com";
const KEEPER_PK = process.env.KEEPER_PK; // same GitHub secret the other keeper scripts use
const DEST = process.env.DEST || "0x3dD5AD9230df6C928C9773cf98401041b24aBc71"; // Pedro's wallet — confirmed 2026-08-30
const GAS_LIMIT = 21000n; // plain ETH transfer, no calldata
const SAFETY_BPS = 2000n; // pad the estimated gas cost by 20% so a fee bump between estimate and inclusion can't cause insufficient-funds

async function main() {
  if (!KEEPER_PK) throw new Error("set KEEPER_PK");
  const p = new ethers.JsonRpcProvider(RPC);
  const w = new ethers.Wallet(KEEPER_PK, p);
  console.log(`sweep-to-owner: from=${w.address} to=${DEST}`);

  const bal = await p.getBalance(w.address);
  console.log(`keeper balance: ${ethers.formatEther(bal)} ETH`);

  const fee = await p.getFeeData();
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice;
  if (!gasPrice) throw new Error("could not read gas price");
  const gasCost = (GAS_LIMIT * gasPrice * (10000n + SAFETY_BPS)) / 10000n;

  if (bal <= gasCost) {
    console.log(`balance (${ethers.formatEther(bal)} ETH) <= padded gas cost (${ethers.formatEther(gasCost)} ETH) — nothing to sweep, skipping`);
    return;
  }

  const sendValue = bal - gasCost;
  console.log(`sending ${ethers.formatEther(sendValue)} ETH to ${DEST} (keeping ${ethers.formatEther(gasCost)} ETH padded gas buffer)`);

  // pin the SAME fee values used to size gasCost above — otherwise ethers re-quotes the fee at
  // broadcast time and a bump between the two reads can exceed the padding and revert the send.
  const txParams = { to: DEST, value: sendValue, gasLimit: GAS_LIMIT };
  if (fee.maxFeePerGas) {
    txParams.maxFeePerGas = fee.maxFeePerGas;
    txParams.maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? fee.maxFeePerGas;
  } else {
    txParams.gasPrice = fee.gasPrice;
  }

  const tx = await w.sendTransaction(txParams);
  const rc = await tx.wait();
  console.log(`sweep ok: ${tx.hash} (block ${rc.blockNumber})`);

  const remaining = await p.getBalance(w.address);
  console.log(`keeper balance after sweep: ${ethers.formatEther(remaining)} ETH`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("SWEEP ERROR:", e.message); process.exit(1); });
