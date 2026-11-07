# Lightspeed V0.5 — what can tell us the color of the current / next candle?

Research brief behind Lightspeed V0.5: the signals with real evidence for short-horizon (seconds to minutes)
direction in bitcoin, how each is computed, where the data comes from, and what Jev is shown on every call.

## 1. The baseline everything is measured against: the math of "where it ends"

A 5-minute Up/Down question asked part-way through a candle is a short binary option struck at the candle's
open. With price displacement `move` (current − open), time left `T` and per-second volatility `σ`, the
random-walk chance of finishing above the open is `P(green) = Φ(ln(S/K) / (σ·√T))` (the N(d₂) of a binary
call with zero rates). This is the single strongest input late in a candle: practitioner bots for Polymarket's
5-minute markets report the window delta ("is BTC up or down vs the window open") as "the dominant signal".
Everything else in Lightspeed is about *adjusting* that baseline.

- Volatility drives it: σ from recent candles (close-to-close, Parkinson high-low, EWMA λ=0.94) and its regime
  (short vs long σ). Higher σ or more time left → closer to 50%.
- Polymarket US 5-minute markets settle on BRTI averaged over the minute at each end, and a tie counts as Up,
  which matters for very small moves.

## 2. Order flow — who is hitting whom (the best-documented short-horizon predictor)

- Order flow imbalance (net aggressive buying minus selling, and changes at the best bid/ask) has a near-linear
  relation with short-horizon price changes (Cont, Kukanov & Stoikov). In BTC/USDT order-book data, trade-flow
  imbalance and order-flow imbalance were the two most important features in a gradient-boosting model of
  mid-price changes (≈45% and 35% importance), and imbalances' explanatory power rose to ≈21% R² once fees applied.
- Abnormal absolute order-flow imbalance and "whale" activity rise sharply before bitcoin price jumps; order-flow
  toxicity (VPIN) predicts jumps.
- Lightspeed: aggressive buy share and net BTC over the last 10 s / 30 s / 60 s, trade rate, largest prints
  (Coinbase trades), plus the per-30-second order flow inside this candle (already sent).

## 3. The order book — resting liquidity and the micro-price

- Volume imbalance at the top of the book, `I = (q_bid − q_ask)/(q_bid + q_ask)`, is "the worst-kept secret of
  high-frequency trading": near +1 the mid tends to tick up, near −1 down. Stoikov's micro-price (mid adjusted by
  imbalance and spread) predicts short-term moves better than the mid.
- Lightspeed: Coinbase and Kraken L2 books → top-of-book imbalance, depth imbalance within 10 and 25 bps, micro-price
  offset, spread, depth.

## 4. Where price is discovered first — other venues and derivatives

- BRTI is computed from the order books of its constituent exchanges (Bitstamp, Coinbase, Gemini, itBit, Kraken,
  LMAX Digital, Bullish, Crypto.com), every 200 ms since May 2026, as the mean of a volume-weighted mid-price curve.
  A venue that is ahead of the others is literally ahead of the index.
- Derivatives lead spot more often than not (MIT DCI: derivatives "more frequently lead price discovery", within
  seconds); CME futures led spot by ≈3 s on average in a time-shift lead-lag study.
- Lightspeed: mids of Coinbase, Kraken, Bitstamp, Gemini and Crypto.com vs their median (bps); Hyperliquid perp
  (mark, oracle, premium, funding, open interest) and Deribit BTC-PERPETUAL (mark vs index basis, funding, OI).

## 5. Serial dependence — does a move continue or revert?

- Bitcoin shows significant negative first-order autocorrelation at intraday 1–30-minute frequencies (partial
  short-term predictability through mean reversion), alongside intraday momentum at the hourly scale; reversal is
  concentrated in high-volume, high-volatility, low-liquidity periods.
- Lightspeed: lag-1 autocorrelation of this chart's candle returns, P(green | last green) and P(green | last red)
  over the last day, streaks, returns over 3/12/48 candles in ATR units.

## 6. The clock — periodicity

- Volatility and volume spike at 0, 8 and 16 UTC (perpetual funding times), peak around 16 UTC and bottom near
  5 UTC, and are higher when US stock markets are open.
- A "turn-of-the-candle" effect: positive returns concentrated in minutes 0/15/30/45 of the hour.
- Lightspeed: UTC/ET time, weekday/weekend, US session, minutes to the next funding time, turn-of-15-minute flag.

## 7. Levels and the crowd

- Prices cluster at round numbers; the distance to $100/$500/$1,000 levels and to the 24 h high/low, measured in ATR,
  tells Jev whether the move has room.
- Polymarket's own Up/Down prices are the crowd's odds for the very question. Short-window liquidity is thin, so they
  can lag the spot move — compare them with the math baseline rather than copy them.

## 8. Already in place before V0.5 (kept)

Last 15 candles, market context (trend, levels, volatility, hourly/4-hour candles, volume), Coinbase order flow per
candle and per 30 s, the TV indicator (EMA 9/21, RSI, ATR scored into a next-candle chance).

## Sources

- Cont, Kukanov & Stoikov, The Price Impact of Order Book Events — order flow imbalance vs short-horizon price change.
- Fee Structure and Order Flow Informativeness in the Cryptocurrency Market (Springer) — TFI/OFI importance, R².
- Scaillet et al., High-Frequency Jump Analysis of the Bitcoin Market — OFI and whales before jumps.
- Bitcoin wild moves: order flow toxicity and price jumps (ScienceDirect) — VPIN.
- Stoikov, The Micro-Price; Pulido, Rosenbaum & Sfendourakis, the "worst-kept secret" of HFT — book imbalance.
- CF Benchmarks: CME CF Real Time Indices methodology and constituent exchange list; CFB Oracle note (200 ms).
- MIT DCI, Price Discovery in the Bitcoin Spot & Derivatives Markets; Bitwise/SEC lead-lag study (CME ≈3 s lead).
- On the Intraday Behavior of Bitcoin (Ledger, 2021) — negative autocorrelation; Intraday return predictability:
  momentum, reversal, or both (2022).
- Periodicity in Cryptocurrency Volatility and Liquidity (arXiv 2109.12142) — 0/8/16 UTC spikes, 16 UTC peak.
- Turn-of-the-candle effect in bitcoin returns (Heliyon 2023).
- Polymarket 5-minute market practitioner write-ups (window delta as the dominant signal; binary-option N(d₂)).
- Hyperliquid info API (metaAndAssetCtxs), Deribit public API, Coinbase Exchange and Kraken public order-book APIs.
