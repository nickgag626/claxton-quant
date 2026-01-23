/**
 * Comprehensive P&L Fix Script
 *
 * This script audits ALL trade groups and fixes incorrect P&L values.
 *
 * Logic for multi-leg (combo) trades:
 * 1. entry_credit = net premium received at entry (in dollars)
 * 2. exit_debit = net cost to close (in dollars)
 *    - If we have per-leg exit prices with different values: calculate direction-aware sum
 *    - If we have same exit_price on all legs (combo fill): use that as net debit
 *    - If only primary leg has exit_price: assume it's the combo net fill price
 * 3. pnl = entry_credit - exit_debit
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';

const envPath = join(process.cwd(), '.env');
const envContent = readFileSync(envPath, 'utf-8');
const envVars: Record<string, string> = {};
for (const line of envContent.split(/\r?\n/)) {
  const match = line.match(/^([^=]+)=["']?([^"']*)["']?$/);
  if (match) envVars[match[1].trim()] = match[2].trim();
}

const supabase = createClient(envVars['VITE_SUPABASE_URL'], envVars['VITE_SUPABASE_PUBLISHABLE_KEY']);

interface Trade {
  id: string;
  trade_group_id: string;
  symbol: string;
  open_side: string | null;
  entry_price: number | null;
  exit_price: number | null;
  entry_credit: number | null;
  exit_debit: number | null;
  pnl: number | null;
  pnl_formula: string | null;
  quantity: number;
  close_status: string | null;
}

async function fixAllPnl() {
  console.log('=== COMPREHENSIVE P&L AUDIT AND FIX ===\n');

  // Fetch ALL trades with a group
  const { data: allTrades, error } = await supabase
    .from('trades')
    .select('*')
    .not('trade_group_id', 'is', null)
    .eq('close_status', 'filled')
    .order('trade_group_id');

  if (error) {
    console.error('Error fetching trades:', error);
    return;
  }

  // Group by trade_group_id
  const groups = new Map<string, Trade[]>();
  for (const t of (allTrades || []) as Trade[]) {
    if (!groups.has(t.trade_group_id)) groups.set(t.trade_group_id, []);
    groups.get(t.trade_group_id)!.push(t);
  }

  console.log(`Found ${groups.size} trade groups to audit\n`);

  let correctCount = 0;
  let fixedCount = 0;
  let errorCount = 0;

  for (const [groupId, legs] of groups) {
    // Sort by symbol for consistent primary leg selection
    legs.sort((a, b) => a.symbol.localeCompare(b.symbol));
    const primary = legs[0];
    const legCount = legs.length;

    // IMPORTANT: The quantity field is sometimes incorrectly set to leg count instead of contracts
    // For multi-leg trades, if quantity == legCount, assume it's 1 contract per leg
    let contracts = Math.abs(primary.quantity || 1);
    if (legCount >= 4 && contracts === legCount) {
      contracts = 1; // Quantity was set to leg count, actual contracts is 1
    }

    // === STEP 1: Determine correct entry_credit ===
    let entryCredit = primary.entry_credit || 0;
    let entryCreditSource = 'stored';

    // Check if entry_credit looks like per-share (< $10 for 4-leg condor)
    if (legCount >= 4 && entryCredit > 0 && entryCredit < 10) {
      entryCredit = entryCredit * contracts * 100;
      entryCreditSource = 'converted_from_per_share';
    }

    // If entry_credit is 0 or missing, calculate from entry prices
    if (entryCredit === 0) {
      for (const leg of legs) {
        if (leg.entry_price && leg.open_side) {
          if (leg.open_side === 'sell_to_open') {
            entryCredit += leg.entry_price * contracts * 100;
          } else if (leg.open_side === 'buy_to_open') {
            entryCredit -= leg.entry_price * contracts * 100;
          }
        }
      }
      entryCreditSource = 'calculated_from_entry_prices';
    }

    // === STEP 2: Determine correct exit_debit ===
    let exitDebit = 0;
    let exitDebitSource = 'unknown';

    // Get legs with exit prices
    const legsWithExit = legs.filter(l => l.exit_price && l.exit_price > 0);

    if (legsWithExit.length === 0) {
      // No exit data - skip this group
      errorCount++;
      continue;
    }

    if (legsWithExit.length === legs.length) {
      // All legs have exit prices - check if they're the same (combo) or different (per-leg)
      const exitPrices = legsWithExit.map(l => l.exit_price!);
      const allSame = exitPrices.every(p => Math.abs(p - exitPrices[0]) < 0.01);

      if (allSame) {
        // Same price on all legs = combo net fill price duplicated
        exitDebit = exitPrices[0] * contracts * 100;
        exitDebitSource = 'combo_fill_all_legs';
      } else {
        // Different prices = actual per-leg fills, use direction-aware calculation
        for (const leg of legs) {
          if (leg.exit_price && leg.open_side) {
            if (leg.open_side === 'sell_to_open') {
              // Short leg: pay to close (buy_to_close)
              exitDebit += leg.exit_price * contracts * 100;
            } else if (leg.open_side === 'buy_to_open') {
              // Long leg: receive to close (sell_to_close)
              exitDebit -= leg.exit_price * contracts * 100;
            }
          }
        }
        exitDebitSource = 'per_leg_direction_aware';
      }
    } else {
      // Partial exit prices - assume available exit_price is combo net fill
      const exitPrice = legsWithExit[0].exit_price!;
      exitDebit = exitPrice * contracts * 100;
      exitDebitSource = 'combo_fill_partial';
    }

    // === STEP 3: Calculate correct P&L ===
    const correctPnl = entryCredit - exitDebit;
    const correctPnlPercent = entryCredit > 0 ? (correctPnl / entryCredit) * 100 : 0;

    // === STEP 4: Check if current values are correct ===
    const currentPnl = primary.pnl || 0;
    const currentExitDebit = primary.exit_debit || 0;
    const currentEntryCredit = primary.entry_credit || 0;

    const pnlDiff = Math.abs(correctPnl - currentPnl);
    const isCorrect = pnlDiff < 1; // Within $1 tolerance

    if (isCorrect) {
      correctCount++;
      continue;
    }

    // === STEP 5: Fix incorrect values ===
    console.log(`\nGroup ${groupId.slice(0, 8)} (${legCount} legs):`);
    console.log(`  Entry: $${currentEntryCredit.toFixed(2)} → $${entryCredit.toFixed(2)} (${entryCreditSource})`);
    console.log(`  Exit:  $${currentExitDebit.toFixed(2)} → $${exitDebit.toFixed(2)} (${exitDebitSource})`);
    console.log(`  P&L:   $${currentPnl.toFixed(2)} → $${correctPnl.toFixed(2)}`);

    const formula = `$${entryCredit.toFixed(2)} - $${exitDebit.toFixed(2)} = $${correctPnl.toFixed(2)} [${exitDebitSource}]`;

    // Update primary leg
    const { error: updateError } = await supabase
      .from('trades')
      .update({
        entry_credit: entryCredit,
        exit_debit: exitDebit,
        pnl: correctPnl,
        pnl_percent: correctPnlPercent,
        pnl_formula: formula,
      })
      .eq('id', primary.id);

    if (updateError) {
      console.error(`  ❌ Error: ${updateError.message}`);
      errorCount++;
    } else {
      console.log(`  ✅ Fixed`);
      fixedCount++;

      // Update entry_credit on non-primary legs for consistency
      for (const leg of legs.slice(1)) {
        await supabase
          .from('trades')
          .update({ entry_credit: entryCredit })
          .eq('id', leg.id);
      }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('AUDIT SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`Total groups:    ${groups.size}`);
  console.log(`Already correct: ${correctCount}`);
  console.log(`Fixed:           ${fixedCount}`);
  console.log(`Errors/Skipped:  ${errorCount}`);
}

fixAllPnl().catch(console.error);
