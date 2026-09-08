/**
 * OCULUS — chain-wide volume-spike + mcap-move + whale watcher
 *
 * Built for traders: surfaces big volume and market-cap moves on already-
 * established Robinhood Chain tokens (not brand-new/thin ones — see the
 * MIN_HOLDERS_COUNT + MIN_VOLUME_24H_USD floor below). "Graduated" launch
 * tokens (pump.fun-style bonding-curve graduation) are NOT covered here —
 * that needs research into whether/what launchpad exists on this chain
 * before it's buildable, which hasn't been done yet.
 *
 * Polls Blockscout's v2 API for Robinhood Chain (chain_id 4663) and emits
 * a "reading" whenever: a token's short-term transfer volume spikes far
 * above its own baseline, its price/market-cap moves sharply over a 15min
 * or 1hr window, or a single transfer moves an outsized share of a
 * token's supply.
 *
 * VERIFIED against the live API on 2026-09-08 (real requests, real
 * response bodies inspected — see field notes below). Known-good as of
 * that date; Blockscout's schema can still change without notice.
 *
 * Two realistic options for the data source, pick one:
 *   A) Free instance API:  https://robinhoodchain.blockscout.com/api/v2/...
 *      (no key required, confirmed reachable, unknown documented rate
 *      limit — POLL_INTERVAL_MS + MIN_VOLUME_24H_USD exist specifically
 *      to keep call volume sane on this tier; watch the logs for 429s)
 *   B) PRO API:            https://api.blockscout.com/v2/...?chain_id=4663
 *      (needs a free key from dev.blockscout.com, higher limits — worth
 *      getting once logging shows real throttling, not before)
 *
 * Field-name corrections made vs. the original draft:
 *   - Token list items use `address_hash`, not `address`.
 *   - `sort=volume_24h` is NOT a valid enum value for GET /tokens — it
 *     400s ({"errors":[{"detail":"Invalid value for enum"}]}). Confirmed
 *     valid sort values: fiat_value, holder_count, circulating_market_cap
 *     (none of these are volume). There is no server-side "sort by 24h
 *     volume," so every page fetched is sorted client-side.
 *   - `total.value` and `timestamp` in the transfers response were correct
 *     in the draft. `total.value` is confirmed to be a raw integer string
 *     in the token's base units (e.g. wei-equivalent) — it must be divided
 *     by 10 ** total.decimals to get a human-readable amount. The draft's
 *     `Number(t.total?.value ?? t.amount ?? 0)` skipped that conversion,
 *     which would have made every amount ~10^18x too large.
 *   - `timestamp` is ISO-8601 with microseconds, e.g.
 *     "2026-09-08T13:27:14.000000Z" — parses fine with `new Date()`.
 *   - `circulating_supply` is `null` on every token observed on this chain
 *     so far (checked hundreds). Whale-% math below falls back to
 *     `total_supply`, which is always populated.
 *
 * Correctness fix beyond field names: the transfers endpoint returns the
 * most-recent N transfers on every call, not "transfers since last poll."
 * Polling it on an interval without de-duplication would re-record the
 * same transfers repeatedly and inflate volume sums. recordTransfer() now
 * takes an id (transaction_hash:log_index), skips ids already seen, and
 * reports whether the transfer was actually new (used to avoid re-firing
 * a whale reading for a transfer already reported on a prior poll).
 *
 * Window design (revised after the first live test):
 *   - SHORT_WINDOW_MS (5 min) and BASELINE_WINDOW_MS (30 min) are
 *     NON-OVERLAPPING. The short window is "the last 5 minutes"; the
 *     baseline window is "the 30 minutes immediately before that" — not
 *     the 30 minutes including the short window. An overlapping baseline
 *     means a genuine spike inflates its own baseline average and damps
 *     its own detected multiplier — and on a cold start, if all fetched
 *     history happened to fall inside the short window, baseline==short
 *     and the multiple was always exactly baselineWindows-to-1 (the
 *     flat 8.0x seen everywhere in first-run testing with the original
 *     overlapping 15min/2hr windows) — an artifact, not a real signal.
 *   - 30 min also cuts practical warm-up time down from the original 2
 *     hours to about 35 minutes.
 *
 * Chain-wide scope (this revision):
 *   - The original draft's approach (and my first fix) only looked at a
 *     single ~50-token page. A live paginated census just found 500+
 *     ERC-20 tokens on this chain with more pages beyond that — polling
 *     every one's transfers endpoint every 15s is not viable on a free
 *     tier. fetchRecentlyActiveTokens() now walks up to MAX_TOKEN_PAGES
 *     of the token list (chain-wide discovery), then applies
 *     MIN_VOLUME_24H_USD as a floor before anything gets individually
 *     polled. Raise MAX_TOKEN_PAGES if you want deeper long-tail coverage
 *     once you've seen real call volume in the logs.
 *
 * Whale detection:
 *   - Fires when a single transfer moves >= WHALE_SUPPLY_PCT_THRESHOLD
 *     percent of a token's total supply (circulating_supply if Blockscout
 *     ever populates it) AND is worth >= WHALE_MIN_USD_VALUE — a relative
 *     measure, not an absolute $/ETH value, so it scales sensibly across
 *     wildly different token sizes. Both numbers are starting points, not
 *     researched — tune them once you see how often it fires on real
 *     traffic. See checkWhaleTransfer() for why the $ floor exists (a real
 *     false-positive found in live testing).
 *
 * Market-cap movement (new):
 *   - The token list already carries `exchange_rate` (price) and
 *     `circulating_market_cap` for every token, refetched every poll — so
 *     tracking price history costs zero extra API calls, just memory.
 *     Every poll snapshots each candidate token's price; checkMcapMoves()
 *     compares the current price to the price ~15min and ~1hr ago and
 *     fires when the move exceeds MCAP_WINDOWS' thresholds. Per your call,
 *     a 10% move is noise for these tokens — thresholds start at 20% over
 *     15min and 50% over 1hr, meaningfully above that. A per-token/window
 *     cooldown (MCAP_MOVE_COOLDOWN_MS) stops the same sustained move from
 *     re-firing every 15s while price stays elevated.
 *   - "Established" filtering: the volume floor alone isn't a great proxy
 *     for "established" — live testing found some bridged tokens report
 *     mainnet-scale volume_24h despite having almost nothing actually
 *     bridged onto this chain (see checkWhaleTransfer's LINK example).
 *     holders_count doesn't have that problem (it's a direct on-chain
 *     count for this chain specifically), so MIN_HOLDERS_COUNT is now a
 *     second, AND'd floor alongside MIN_VOLUME_24H_USD.
 */

const BASE_URL = "https://robinhoodchain.blockscout.com/api/v2";
// const BASE_URL = "https://api.blockscout.com/v2"; // + chain_id=4663 param, if using PRO

const CONFIG = {
  POLL_INTERVAL_MS: 15_000,        // how often to fetch new transfers per token
  SHORT_WINDOW_MS: 5 * 60_000,     // 5 min "spike" window (most recent)
  BASELINE_WINDOW_MS: 30 * 60_000, // 30 min baseline window, immediately BEFORE the short window (non-overlapping)
  SPIKE_MULTIPLIER: 4,             // short window rate must exceed baseline rate * this
  MIN_BASELINE_VOLUME: 0.5,        // ignore tokens with near-zero baseline (in whole-token units, post decimals)
  MIN_TRANSFERS_FOR_BASELINE: 5,   // don't judge a token until it has some history across short+baseline combined

  MAX_TOKEN_PAGES: 10,             // chain-wide token-list pagination cap per poll cycle (~50 tokens/page)
  MIN_VOLUME_24H_USD: 5000,        // floor: don't individually poll a token below this 24h volume
  MIN_HOLDERS_COUNT: 500,          // AND'd with the volume floor — "established" proxy that isn't fooled by thin-bridge volume numbers

  WHALE_SUPPLY_PCT_THRESHOLD: 0.5, // flag a single transfer moving >= this % of total supply
  WHALE_MIN_USD_VALUE: 2000,       // ...AND worth at least this many USD (see note in checkWhaleTransfer)

  MCAP_MOVE_COOLDOWN_MS: 5 * 60_000, // don't re-fire the same token+window mcap move within this long
};

// price move windows checked on every poll — tune pctThreshold per window independently
const MCAP_WINDOWS = [
  { label: "15min", windowMs: 15 * 60_000, pctThreshold: 20 },
  { label: "1hr", windowMs: 60 * 60_000, pctThreshold: 50 },
];

// how far back we need to keep transfers so both windows stay fully populated
const TOTAL_LOOKBACK_MS = CONFIG.SHORT_WINDOW_MS + CONFIG.BASELINE_WINDOW_MS;

// per-token rolling transfer log: { [tokenAddress]: [{ ts, amount, id }, ...] }
const tokenWindows = new Map();
// per-token set of transfer ids already recorded, so re-polling the same
// recent-transfers page doesn't double-count or re-fire whale readings.
const tokenSeenIds = new Map();

// per-token price history for mcap-move detection: { [tokenAddress]: [{ ts, price }, ...] }
const tokenPriceHistory = new Map();
// per-(token+window) last-fired time, so a sustained move doesn't re-fire every poll
const lastMcapReadingAt = new Map();

/**
 * Walk the token list chain-wide via next_page_params, up to MAX_TOKEN_PAGES.
 * Logs a warning if the cap was hit with more pages remaining.
 */
async function fetchAllTokenPages(maxPages = CONFIG.MAX_TOKEN_PAGES) {
  let all = [];
  let params = "";
  let page = 0;
  let hasMore = true;

  while (hasMore && page < maxPages) {
    const res = await fetch(`${BASE_URL}/tokens?type=ERC-20${params}`);
    if (!res.ok) throw new Error(`token list page ${page} fetch failed: ${res.status}`);
    const data = await res.json();
    all = all.concat(data.items ?? []);
    page++;
    if (data.next_page_params) {
      const p = data.next_page_params;
      params = "&" + Object.entries(p).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    } else {
      hasMore = false;
    }
  }

  return { items: all, truncated: hasMore };
}

/**
 * Chain-wide candidate list: paginate the full token list, apply the
 * volume floor, sort what's left by 24h volume descending. This is what
 * keeps the per-token transfer polling below from blowing up on a chain
 * with hundreds+ of tokens.
 */
async function fetchRecentlyActiveTokens() {
  const { items, truncated } = await fetchAllTokenPages();
  if (truncated) {
    console.warn(
      `[oculus] token list has more than ${CONFIG.MAX_TOKEN_PAGES} pages (~${CONFIG.MAX_TOKEN_PAGES * 50}+ tokens) — ` +
      `raise MAX_TOKEN_PAGES to see further down the list`
    );
  }
  const floored = items.filter(t =>
    Number(t.volume_24h ?? 0) >= CONFIG.MIN_VOLUME_24H_USD &&
    Number(t.holders_count ?? 0) >= CONFIG.MIN_HOLDERS_COUNT
  );
  return floored.slice().sort((a, b) => Number(b.volume_24h ?? 0) - Number(a.volume_24h ?? 0));
}

async function fetchTokenTransfers(tokenAddress) {
  const res = await fetch(`${BASE_URL}/tokens/${tokenAddress}/transfers`);
  if (!res.ok) throw new Error(`transfers fetch failed for ${tokenAddress}: ${res.status}`);
  const data = await res.json();
  return data.items ?? [];
}

/**
 * Records a transfer into the token's rolling window. Returns true if this
 * transfer was new (not seen on a previous poll), false if it was a dupe.
 */
function recordTransfer(tokenAddress, amount, timestampMs, id) {
  if (!tokenWindows.has(tokenAddress)) tokenWindows.set(tokenAddress, []);
  if (!tokenSeenIds.has(tokenAddress)) tokenSeenIds.set(tokenAddress, new Set());

  const seen = tokenSeenIds.get(tokenAddress);
  if (id && seen.has(id)) return false; // already recorded this transfer on a previous poll
  if (id) seen.add(id);

  const log = tokenWindows.get(tokenAddress);
  log.push({ ts: timestampMs, amount, id });

  // prune anything older than what either window could ever need
  const cutoff = Date.now() - TOTAL_LOOKBACK_MS;
  while (log.length && log[0].ts < cutoff) {
    const dropped = log.shift();
    if (dropped.id) seen.delete(dropped.id);
  }

  return true;
}

function sumRange(log, fromMs, toMs) {
  return log
    .filter(t => t.ts >= fromMs && t.ts < toMs)
    .reduce((sum, t) => sum + t.amount, 0);
}

/**
 * Check one token's window for a volume spike. Returns a reading or null.
 * Short window = last SHORT_WINDOW_MS. Baseline window = the
 * BASELINE_WINDOW_MS immediately before that — the two never overlap.
 */
function checkSpike(tokenAddress, tokenSymbol) {
  const log = tokenWindows.get(tokenAddress);
  if (!log || log.length < CONFIG.MIN_TRANSFERS_FOR_BASELINE) return null;

  const now = Date.now();
  const shortStart = now - CONFIG.SHORT_WINDOW_MS;
  const baselineStart = shortStart - CONFIG.BASELINE_WINDOW_MS;

  const shortVolume = sumRange(log, shortStart, now);
  const baselineVolume = sumRange(log, baselineStart, shortStart);

  const baselineWindows = CONFIG.BASELINE_WINDOW_MS / CONFIG.SHORT_WINDOW_MS;
  const baselineRate = baselineVolume / baselineWindows;

  if (baselineRate < CONFIG.MIN_BASELINE_VOLUME) return null; // too illiquid to judge

  const multiple = shortVolume / baselineRate;

  if (multiple >= CONFIG.SPIKE_MULTIPLIER) {
    const baselineMinutes = CONFIG.BASELINE_WINDOW_MS / 60_000;
    return {
      tag: "volume",
      label: "VOLUME",
      token: tokenSymbol,
      multiple: multiple.toFixed(1),
      text: `${tokenSymbol} trading ${multiple.toFixed(1)}x above its ${baselineMinutes}min baseline.`,
      timestamp: new Date().toISOString(),
    };
  }
  return null;
}

/**
 * Snapshot a token's current price. Costs nothing extra — exchange_rate
 * comes from the token-list fetch every poll cycle already does. Pruned to
 * the longest MCAP_WINDOWS window so history doesn't grow unbounded.
 */
function recordPriceSnapshot(tokenAddress, price, timestampMs) {
  if (!Number.isFinite(price) || price <= 0) return;
  if (!tokenPriceHistory.has(tokenAddress)) tokenPriceHistory.set(tokenAddress, []);
  const hist = tokenPriceHistory.get(tokenAddress);
  hist.push({ ts: timestampMs, price });

  const maxWindowMs = Math.max(...MCAP_WINDOWS.map(w => w.windowMs));
  const cutoff = timestampMs - maxWindowMs;
  while (hist.length && hist[0].ts < cutoff) hist.shift();
}

/**
 * Check a token's price history against each configured window. For each
 * window, finds the snapshot closest to (but not after) "windowMs ago" as
 * the reference point and compares it to the current price. Applies a
 * per-token/window cooldown so a sustained move doesn't re-fire every poll.
 */
function checkMcapMoves(tokenAddress, tokenSymbol) {
  const hist = tokenPriceHistory.get(tokenAddress);
  if (!hist || hist.length < 2) return [];

  const now = hist[hist.length - 1].ts;
  const currentPrice = hist[hist.length - 1].price;
  const readings = [];

  for (const w of MCAP_WINDOWS) {
    const targetTs = now - w.windowMs;
    let ref = null;
    for (const snap of hist) {
      if (snap.ts <= targetTs) ref = snap;
      else break;
    }
    if (!ref || ref.price <= 0) continue; // not enough history yet for this window

    const pct = ((currentPrice - ref.price) / ref.price) * 100;
    if (Math.abs(pct) < w.pctThreshold) continue;

    const key = `${tokenAddress}:${w.label}`;
    const lastFired = lastMcapReadingAt.get(key) || 0;
    if (now - lastFired < CONFIG.MCAP_MOVE_COOLDOWN_MS) continue;
    lastMcapReadingAt.set(key, now);

    readings.push({
      tag: "mcap",
      label: "MCAP",
      token: tokenSymbol,
      pct: pct.toFixed(1),
      window: w.label,
      text: `${tokenSymbol} price ${pct >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}% over the last ${w.label}.`,
      timestamp: new Date(now).toISOString(),
    });
  }

  return readings;
}

/**
 * Check a single transfer against the whale threshold: does it move
 * >= WHALE_SUPPLY_PCT_THRESHOLD percent of the token's supply, AND is it
 * worth at least WHALE_MIN_USD_VALUE?
 *
 * The $ floor exists because of a real finding from live testing: some
 * bridged blue-chip tokens (LINK observed directly) have only a tiny
 * amount actually bridged onto this chain relative to their globally-
 * reported price, so a small, unremarkable transfer can read as a huge
 * percentage of the on-chain supply (a ~$1,100 LINK transfer showed as
 * 58% of "supply" here). There's no reliable way to tell that case apart
 * from a genuinely thin-liquidity token where a big % move IS the
 * interesting signal (PENGU showed the same thin-bridge pattern but its
 * real transfer data also produced a genuine volume spike) — so this
 * requires both conditions rather than trying to algorithmically exclude
 * "thin bridge" tokens. Tune both numbers against real output.
 *
 * circulating_supply is null on every token seen so far, so this falls
 * back to total_supply.
 */
function checkWhaleTransfer(token, transferAmount) {
  const decimals = Number(token.decimals ?? 18);
  const supplyRaw = token.circulating_supply ?? token.total_supply;
  if (supplyRaw == null) return null;

  const supply = Number(supplyRaw) / 10 ** decimals;
  if (!supply || supply <= 0) return null;

  const pct = (transferAmount / supply) * 100;
  if (pct < CONFIG.WHALE_SUPPLY_PCT_THRESHOLD) return null;

  const usdValue = transferAmount * Number(token.exchange_rate ?? 0);
  if (usdValue < CONFIG.WHALE_MIN_USD_VALUE) return null;

  return { pct, usdValue };
}

/**
 * One full poll cycle: refresh the chain-wide (floored) candidate list,
 * pull each token's recent transfers, update rolling windows, check each
 * for a volume spike or whale transfer, return any new readings.
 */
async function pollOnce() {
  const readings = [];
  const tokens = await fetchRecentlyActiveTokens();
  console.log(
    `[oculus] poll: ${tokens.length} tokens above the $${CONFIG.MIN_VOLUME_24H_USD} volume / ` +
    `${CONFIG.MIN_HOLDERS_COUNT} holders floor`
  );
  const pollTs = Date.now();

  for (const token of tokens) {
    const address = token.address_hash;
    const symbol = token.symbol ?? "UNKNOWN";

    recordPriceSnapshot(address, Number(token.exchange_rate ?? 0), pollTs);
    const mcapMoves = checkMcapMoves(address, symbol);
    if (mcapMoves.length) readings.push(...mcapMoves);

    try {
      const transfers = await fetchTokenTransfers(address);
      for (const t of transfers) {
        const decimals = Number(t.total?.decimals ?? token.decimals ?? 18);
        const rawValue = t.total?.value;
        const amount = rawValue != null ? Number(rawValue) / 10 ** decimals : 0;
        const ts = new Date(t.timestamp ?? Date.now()).getTime();
        const id = t.transaction_hash && t.log_index != null
          ? `${t.transaction_hash}:${t.log_index}`
          : undefined;

        const isNew = recordTransfer(address, amount, ts, id);

        if (isNew) {
          const whale = checkWhaleTransfer(token, amount);
          if (whale) {
            readings.push({
              tag: "whale",
              label: "WHALE",
              token: symbol,
              pct: whale.pct.toFixed(3),
              usdValue: whale.usdValue,
              text: `${symbol}: single transfer moved ${whale.pct.toFixed(2)}% of on-chain supply (~$${Math.round(whale.usdValue).toLocaleString()}).`,
              timestamp: new Date(ts).toISOString(),
              transaction_hash: t.transaction_hash,
            });
          }
        }
      }

      const spike = checkSpike(address, symbol);
      if (spike) readings.push(spike);
    } catch (err) {
      console.error(`[oculus] skipped ${symbol} (${address}):`, err.message);
    }
  }

  if (readings.length) {
    console.log(`[oculus] poll found ${readings.length} reading(s):`, readings.map(r => r.text));
  }

  return readings;
}

/**
 * Start continuous polling. onReading(reading) fires for each new
 * spike/mcap/whale reading detected — { tag, label, text, timestamp, ... }.
 * onPollComplete(err, info) is optional and fires after every poll cycle
 * regardless of whether it found anything (info.readingCount) or failed
 * (err) — useful for a server to track "is this actually still alive"
 * without scraping console output.
 */
function startWatching(onReading, onPollComplete) {
  console.log(`[oculus] starting watcher: poll every ${CONFIG.POLL_INTERVAL_MS / 1000}s`);

  const tick = async () => {
    try {
      const readings = await pollOnce();
      readings.forEach(onReading);
      if (onPollComplete) onPollComplete(null, { readingCount: readings.length });
    } catch (err) {
      console.error("[oculus] poll cycle failed:", err.message);
      if (onPollComplete) onPollComplete(err, null);
    }
  };

  tick(); // fire the first poll immediately instead of waiting a full interval
  setInterval(tick, CONFIG.POLL_INTERVAL_MS);
}

module.exports = {
  startWatching,
  pollOnce,
  CONFIG,
  // exported for testing/verification only
  fetchAllTokenPages,
  fetchRecentlyActiveTokens,
  fetchTokenTransfers,
  recordTransfer,
  checkSpike,
  checkWhaleTransfer,
  recordPriceSnapshot,
  checkMcapMoves,
  tokenWindows,
  tokenPriceHistory,
};
