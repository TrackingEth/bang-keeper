# $BANG keeper (permissionless, self-funding)

Drives the $BANG distribution on a schedule, for free, forever. It calls:
- **`buyAll`** — buys the 8 tokenized stocks with the accumulated 4% fees and credits holders. **Permissionless** — anyone can call it, and the caller earns **1% of the round** (`KEEPER_BPS`), which self-funds the gas. No privileged key.
- **`processRewardClaims`** — pushes the accrued stocks straight to holders' wallets (gas-bounded round-robin).

Because the 1% reward > the gas, any wallet running this **profits**, so the mechanic keeps running even if the founder disappears. The wallet here is a **throwaway EOA**, never the owner/curator — if its key leaks the worst case is bounded MEV, never fund loss.

## Setup (≈5 min, free)

1. **Create a NEW dedicated wallet** (fresh EOA) — this is the keeper. Do **NOT** use the owner/curator key.
2. **Fund it** with a small ETH buffer on Robinhood Chain (~$5–10). The 1% reward tops it back up over time, so this is a one-time seed, not ongoing funding.
3. **Create a public GitHub repo** (public = free unlimited Actions minutes) and push these files (`keeper.js`, `package.json`, `.github/workflows/keeper.yml`).
4. In the repo: **Settings → Secrets and variables → Actions → New secret** → name `KEEPER_PK`, value = the throwaway wallet's private key.
5. **After the real $BANG launch**, set the deployed addresses: either edit `TREASURY`/`TOKEN` at the top of `keeper.js`, or add them as repo secrets/variables. (They are pre-filled with the pre-mined vanity targets.)
6. Enable Actions. It runs every ~10 min. Trigger a manual run first from the **Actions** tab (`workflow_dispatch`) to confirm.

## Recycling — the keeper gives its profit back to holders
The keeper does **not** hoard the 1% it earns. Once its own wallet passes `RECYCLE_AT` (default **1 ETH**), it keeps at most `KEEP_GAS` (default **0.005 ETH**) for gas and sends the rest back to the treasury — where the next `buyAll` turns it into stocks airdropped to holders. So the keeper runs at ~break-even and everything above the gas buffer flows to holders. (A lower `RECYCLE_AT` recycles sooner = less idle ETH sitting in the keeper; the default batches the give-back at 1 ETH. The 0.005 buffer covers a comfortable run of gas even if volume drops right after a recycle.)

## Tuning (optional repo variables/secrets)
- `RECYCLE_AT` (default `1`) / `KEEP_GAS` (default `0.005`) — recycle the keeper's excess back to holders above `RECYCLE_AT`, keeping at most `KEEP_GAS` for gas.
- `MIN_POT_ETH` (default `0.02`) — only fire `buyAll` once the treasury holds at least this much (so a round is worth the gas).
- `SLIPPAGE_BPS` (default `1500`) — `minOut` = 85% of the on-chain spot estimate (covers the 5% pool fee + impact). Lower = tighter (less MEV, more reverts); higher = looser.
- `PROCESS_GAS` (default `900000`) — gas budget for the auto-claim push per run.
- `RPC` (default the Robinhood mainnet RPC).

## Notes
- **GitHub cron may run late** (minutes). That's fine — it's a distribution cadence, not a deadline; fees just accumulate a bit longer. For rock-solid timing use a $5 VPS cron or Cloudflare Cron instead (same `keeper.js`).
- **collectLpFees (the BlackBerry burn)** stays keeper-gated on-chain (anti-MEV) and is NOT run here — trigger it separately, or register this wallet as a keeper via the treasury owner if you want it automated too.
- Anyone can run their own copy of this against the same contract and also earn the 1% — that redundancy is the point.
