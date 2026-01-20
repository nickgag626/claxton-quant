# Trading System Improvements Plan

**Date:** 2026-01-20
**Author:** Claude Opus 4.5

---

## A) TOP 10 PRODUCTION RISKS

| # | Risk | Severity | Impact | Current Mitigation |
|---|------|----------|--------|-------------------|
| 1 | **No heartbeat monitoring for check_exits** | CRITICAL | Exits could silently stop running; positions held past profit targets | None - relies on visual inspection of logs |
| 2 | **Market orders only - no slippage protection** | HIGH | Poor fills during volatility; can lose 2-5% per trade on wide spreads | Bid/ask spread validation before entry (10% max) |
| 3 | **In-memory caches lost on edge function restart** | HIGH | Entry cooldowns and in-flight checks reset; duplicate orders possible | 90s TTL limits exposure window |
| 4 | **No bid/ask spread check on exit orders** | HIGH | Can exit into extremely wide spreads during fast markets | None |
| 5 | **Partial fill auto-bailout is aggressive** | HIGH | Closes filled legs immediately at market; may lock in losses | Manual recovery UI available |
| 6 | **Entry credit NULL causes pnlPercent=0** | MEDIUM | Exit triggers never fire for positions with missing entry credit | Warning logged but no fallback calculation |
| 7 | **Single polling loop in browser** | MEDIUM | If tab backgrounded, polling slows to 2min; exits delayed | Jitter + backoff in place |
| 8 | **No slippage tracking or analytics** | MEDIUM | Cannot measure execution quality or detect broker issues | Entry credit calculated from actual fills |
| 9 | **Close order retry requires manual intervention** | MEDIUM | Rejected/timeout closes don't auto-retry; positions stuck open | Recovery panel for manual resolution |
| 10 | **Strategy evaluations table grows unbounded** | LOW | Database bloat over time; query performance degrades | Deduplication reduces writes |

---

## B) TOP 10 UX IMPROVEMENT OPPORTUNITIES

| # | Opportunity | Impact | Effort |
|---|-------------|--------|--------|
| 1 | **Strategy health panel** - Show last check_exits time, last evaluation, quote staleness | Trust & debugging | M |
| 2 | **"NO TRIGGER" visibility in UI** - Show why positions didn't exit (pnl% vs threshold) | Operator understanding | S |
| 3 | **Mark vs fill P&L comparison** - Show expected P&L at trigger vs actual realized | Execution quality | M |
| 4 | **Dry-run mode with visual feedback** - "Would trade" signals without placing orders | Testing & confidence | M |
| 5 | **Slippage dashboard** - Entry estimate vs fill, exit mark vs fill | Performance analytics | L |
| 6 | **Position age indicator** - Show how long position has been open | Time awareness | S |
| 7 | **Exit countdown** - Visual indicator of time until time-stop triggers | Predictability | S |
| 8 | **Correlation ID in activity log** - Link related events (entry → exit → journal) | Debugging | S |
| 9 | **Strategy performance by config** - Which delta/DTE combos perform best | Optimization | L |
| 10 | **Mobile-friendly alerts** - Discord/webhook for critical events | Remote monitoring | M |

---

## C) PRIORITIZED ROADMAP

### TIER 1: MUST HAVE (Production Safety)

| Item | Description | Why It Matters | Risk | Effort | Validation |
|------|-------------|----------------|------|--------|------------|
| **1.1 Heartbeat Monitor** | Track last successful check_exits timestamp; alert if stale >60s | Detects silent failures that could miss exits | LOW | S | UI shows heartbeat status; log shows timestamps |
| **1.2 Exit Spread Gate** | Block exit orders when bid/ask spread > threshold (e.g., 15%) | Prevents terrible fills during fast markets | LOW | S | Log shows blocked exits with spread details |
| **1.3 Entry Credit Fallback** | If Tradier leg array missing, calculate from position marks | Ensures pnlPercent > 0 so exits can trigger | LOW | S | Existing positions get retroactive credit calc |
| **1.4 Close Order Auto-Retry** | On timeout_unknown, auto-retry once after 30s delay | Reduces manual intervention for transient failures | MEDIUM | M | Log shows retry attempts and outcomes |

### TIER 2: SHOULD HAVE (Performance & UX)

| Item | Description | Why It Matters | Risk | Effort | Validation |
|------|-------------|----------------|------|--------|------------|
| **2.1 Slippage Tracking** | Store entry_estimate vs entry_fill, exit_mark vs exit_fill | Measure execution quality; detect broker issues | LOW | M | New columns in trades table; dashboard view |
| **2.2 NO TRIGGER Visibility** | Show in UI why each position didn't trigger exit | Reduces confusion; builds operator trust | LOW | S | PositionsPanel shows "50% profit target, currently at 32%" |
| **2.3 Position Age Display** | Show time since entry in positions panel | Helps identify stuck positions | LOW | S | UI shows "Open 2h 15m" |
| **2.4 Limit Order Option** | Add option to use limit orders (mid ± buffer) instead of market | Better fills; reduced slippage | MEDIUM | L | Config flag; A/B test fill quality |
| **2.5 Correlation IDs** | Add traceId to all related events (entry→exit→journal) | Debug complex multi-leg issues | LOW | M | Activity log links related events |

### TIER 3: NICE TO HAVE (Polish & Advanced)

| Item | Description | Why It Matters | Risk | Effort | Validation |
|------|-------------|----------------|------|--------|------------|
| **3.1 Dry-Run Mode** | Show "would trade" signals without placing real orders | Safe testing of config changes | LOW | M | UI toggle; visual signal display |
| **3.2 Discord/Webhook Alerts** | Critical event notifications (rejections, partial fills) | Remote monitoring capability | LOW | M | Test webhook endpoint |
| **3.3 Strategy Performance Dashboard** | P&L by delta, DTE, underlying, time-of-day | Optimization insights | LOW | L | New analytics page |
| **3.4 Exit Countdown Timer** | Visual countdown to time-stop trigger | Predictability | LOW | S | UI shows "Time stop in 45min" |
| **3.5 Volatility Regime Filter** | Skip entries during high VIX or post-event periods | Risk reduction | MEDIUM | L | Config option; backtest validation |

---

## D) IMPLEMENTING HIGH-IMPACT IMPROVEMENTS

### Improvement #1: Strategy Health Heartbeat Monitor

**Why:** If check_exits silently fails, positions could be held past profit targets with no indication to the operator.

**Spec:**
- Track `lastCheckExitsTimestamp` in state
- Display in StatusRibbon: "Exits: 15s ago" with color coding (green <30s, yellow <60s, red >60s)
- Log warning if gap exceeds 60 seconds
- Include in strategy evaluation panel

### Improvement #2: Exit Bid/Ask Spread Safety Gate

**Why:** During fast markets, bid/ask spreads can widen dramatically. Exiting into a 50% spread could wipe out profits.

**Spec:**
- Before placing close order, fetch quotes for all legs
- Calculate spread % for each leg
- If any leg spread > MAX_EXIT_SPREAD_PERCENT (default 15%), block exit and log
- Allow override for emergency closes

### Improvement #3: Slippage Tracking

**Why:** Cannot currently measure execution quality or detect systematic broker issues.

**Spec:**
- Add `entry_estimate`, `entry_slippage`, `exit_mark`, `exit_slippage` columns to trades table
- On entry: store bid/ask midpoint as estimate, calculate slippage = fill - estimate
- On exit: store mark at trigger time, calculate slippage = fill - mark
- Aggregate in trade stats

### Improvement #4: NO TRIGGER Reason Display

**Why:** Users see positions sitting at 45% profit and wonder why they haven't exited. The diagnostic logging exists but isn't visible in UI.

**Spec:**
- Return `exitStatus` object from check_exits for each position group
- Include: currentPnlPercent, profitTargetPercent, stopLossPercent, reason
- Display in PositionsPanel: "45%/50% profit target" or "Status: Holding (-12% / -100% stop)"

---

## E) IMPLEMENTED IMPROVEMENTS

### Completed Improvements

#### 1. Heartbeat Monitor (DONE)
- Added `lastCheckExitsTime` state tracking in `useTradingData.ts`
- Updated `StatusRibbon.tsx` to display heartbeat status with color coding:
  - Green: <45 seconds since last check
  - Amber: 45-90 seconds
  - Red: >90 seconds
- Wired through `Index.tsx` to StatusRibbon

#### 2. Exit Bid/Ask Spread Safety Gate (DONE)
- Added `MAX_EXIT_SPREAD_PERCENT` constant (15%) in `tradier-api/index.ts`
- Added spread check before placing close orders in both `close_group` and `close_position` actions
- Added `forceClose` parameter to bypass spread check for emergency situations
- Emergency closes automatically bypass the spread check
- Updated frontend to handle spread-blocked responses with activity log notifications

#### 3. NO TRIGGER Reason Display (DONE)
- Added `exitStatus` array to `check_exits` response in strategy-engine
- Each group includes: `pnlPercent`, `profitTargetPercent`, `stopLossPercent`, `dte`, `timeStopDte`, `triggered`, `reason`, `blockedReason`
- Added `ExitStatus` interface in `strategyEngine.ts`
- Added `exitStatusMap` state and `getExitStatus` helper in `useTradingData.ts`
- Updated `PositionsPanel.tsx` with new EXIT column showing:
  - P&L% vs target thresholds (e.g., "32% / 50%")
  - Color-coded based on proximity to trigger
  - Tooltip with full threshold details
  - BLOCKED status for broken structures

### Deferred Improvements

#### 4. Slippage Tracking (Deferred - Needs DB Migration)
- Requires adding columns: `entry_estimate`, `entry_slippage`, `exit_mark`, `exit_slippage`
- Needs database migration and updates across entry/exit flows
- Recommended for future implementation

---

## Files Modified

**Backend (Supabase Edge Functions):**
- `supabase/functions/tradier-api/index.ts` - Added spread safety gate
- `supabase/functions/strategy-engine/index.ts` - Added exitStatus tracking

**Frontend:**
- `src/hooks/useTradingData.ts` - Added heartbeat, exit status state, forceClose handling
- `src/pages/Index.tsx` - Wired new props
- `src/components/dashboard/StatusRibbon.tsx` - Added heartbeat display
- `src/components/dashboard/PositionsPanel.tsx` - Added EXIT column and status display
- `src/services/tradierApi.ts` - Added forceClose parameter and blocked response handling
- `src/services/strategyEngine.ts` - Added ExitStatus interface
