/**
 * READ-ONLY DIAGNOSTIC SCRIPT
 * Fetches trade groups and prints truth tables for analysis.
 * NO WRITES - purely for diagnosis.
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
  pnl_percent: number | null;
  pnl_formula: string | null;
  quantity: number;
  close_status: string | null;
  close_reason: string | null;
  exit_reason: string | null;
  strategy_type: string | null;
  created_at: string | null;
  exit_time: string | null;
}

async function diagnose() {
  console.log('=' .repeat(80));
  console.log('TRADE P&L DIAGNOSTIC REPORT (READ-ONLY)');
  console.log('=' .repeat(80));
  console.log(`Generated: ${new Date().toISOString()}\n`);

  // Fetch ALL closed trade groups
  const { data: allTrades, error } = await supabase
    .from('trades')
    .select('*')
    .not('trade_group_id', 'is', null)
    .eq('close_status', 'filled')
    .order('exit_time', { ascending: false });

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

  console.log(`Total closed trade groups: ${groups.size}\n`);

  // Categorize issues
  const issues = {
    qty_equals_legcount: [] as string[],
    stop_loss_positive_pnl: [] as string[],
    profit_target_negative_pnl: [] as string[],
    missing_entry_credit: [] as string[],
    missing_exit_data: [] as string[],
    pnl_mismatch: [] as string[],
    all_legs_same_exit: [] as string[],
  };

  const detailedGroups: Array<{
    groupId: string;
    closedAt: string;
    legCount: number;
    underlying: string;
    exitReason: string;
    storedPnl: number;
    storedEntryCredit: number;
    storedExitDebit: number;
    computedEntryCredit: number;
    computedExitDebit: number;
    computedPnl: number;
    contracts: number;
    quantityField: number;
    exitPriceSource: string;
    warnings: string[];
    legs: Array<{
      symbol: string;
      openSide: string;
      entryPrice: number;
      exitPrice: number;
      quantity: number;
      isPrimary: boolean;
    }>;
  }> = [];

  for (const [groupId, legs] of groups) {
    // Sort by symbol for consistent primary leg selection
    legs.sort((a, b) => a.symbol.localeCompare(b.symbol));
    const primary = legs[0];
    const legCount = legs.length;

    const warnings: string[] = [];

    // Extract underlying from symbol (e.g., "SPY250124C00685000" -> "SPY")
    const underlying = primary.symbol.replace(/\d.*/, '');

    // Check quantity field
    const quantityField = Math.abs(primary.quantity || 1);
    let contracts = quantityField;
    if (legCount >= 4 && quantityField === legCount) {
      warnings.push(`QTY_EQUALS_LEGCOUNT: quantity=${quantityField} == legCount=${legCount}`);
      issues.qty_equals_legcount.push(groupId);
      contracts = 1; // Assume 1 contract when qty == legCount
    }

    // Stored values from primary leg
    const storedPnl = Number(primary.pnl) || 0;
    const storedEntryCredit = Number(primary.entry_credit) || 0;
    const storedExitDebit = Number(primary.exit_debit) || 0;
    const exitReason = primary.exit_reason || primary.close_reason || 'unknown';

    // Compute entry credit from leg entry prices (direction-aware)
    let computedEntryCredit = 0;
    for (const leg of legs) {
      const entryPrice = Number(leg.entry_price) || 0;
      if (leg.open_side === 'sell_to_open') {
        computedEntryCredit += entryPrice * contracts * 100;
      } else if (leg.open_side === 'buy_to_open') {
        computedEntryCredit -= entryPrice * contracts * 100;
      }
    }

    // Analyze exit prices
    const legsWithExit = legs.filter(l => l.exit_price && Number(l.exit_price) > 0);
    const exitPrices = legsWithExit.map(l => Number(l.exit_price));
    const allSameExitPrice = exitPrices.length > 0 && exitPrices.every(p => Math.abs(p - exitPrices[0]) < 0.001);

    let exitPriceSource = 'unknown';
    let computedExitDebit = 0;

    if (legsWithExit.length === 0) {
      warnings.push('MISSING_EXIT_DATA: No legs have exit prices');
      issues.missing_exit_data.push(groupId);
      exitPriceSource = 'none';
    } else if (allSameExitPrice && legsWithExit.length === legCount) {
      // All legs have same exit price - likely combo net fill duplicated
      exitPriceSource = 'COMBO_NET_DUPLICATED';
      computedExitDebit = exitPrices[0] * contracts * 100;
      issues.all_legs_same_exit.push(groupId);
    } else if (legsWithExit.length === 1 && legCount > 1) {
      // Only one leg has exit price - likely combo net fill on primary only
      exitPriceSource = 'COMBO_NET_PRIMARY_ONLY';
      computedExitDebit = exitPrices[0] * contracts * 100;
    } else if (legsWithExit.length === legCount && !allSameExitPrice) {
      // All legs have different exit prices - per-leg fills
      exitPriceSource = 'PER_LEG_FILLS';
      for (const leg of legs) {
        const exitPrice = Number(leg.exit_price) || 0;
        if (leg.open_side === 'sell_to_open') {
          computedExitDebit += exitPrice * contracts * 100; // Pay to close short
        } else if (leg.open_side === 'buy_to_open') {
          computedExitDebit -= exitPrice * contracts * 100; // Receive to close long
        }
      }
    } else {
      // Partial exit data
      exitPriceSource = 'PARTIAL';
      warnings.push(`PARTIAL_EXIT_DATA: ${legsWithExit.length}/${legCount} legs have exit prices`);
    }

    // Compute P&L
    const computedPnl = computedEntryCredit - computedExitDebit;

    // Check for issues
    if (storedEntryCredit === 0 || storedEntryCredit < 10) {
      warnings.push(`MISSING_OR_LOW_ENTRY_CREDIT: ${storedEntryCredit}`);
      issues.missing_entry_credit.push(groupId);
    }

    const pnlDiff = Math.abs(computedPnl - storedPnl);
    if (pnlDiff > 1) {
      warnings.push(`PNL_MISMATCH: stored=${storedPnl.toFixed(2)}, computed=${computedPnl.toFixed(2)}, diff=${pnlDiff.toFixed(2)}`);
      issues.pnl_mismatch.push(groupId);
    }

    // Check exit reason vs P&L sign
    if (exitReason === 'stop_loss' && storedPnl > 0) {
      warnings.push(`STOP_LOSS_POSITIVE: exit_reason=stop_loss but pnl=${storedPnl.toFixed(2)}`);
      issues.stop_loss_positive_pnl.push(groupId);
    }
    if (exitReason === 'profit_target' && storedPnl < 0) {
      warnings.push(`PROFIT_TARGET_NEGATIVE: exit_reason=profit_target but pnl=${storedPnl.toFixed(2)}`);
      issues.profit_target_negative_pnl.push(groupId);
    }

    detailedGroups.push({
      groupId,
      closedAt: primary.exit_time || '',
      legCount,
      underlying,
      exitReason,
      storedPnl,
      storedEntryCredit,
      storedExitDebit,
      computedEntryCredit,
      computedExitDebit,
      computedPnl,
      contracts,
      quantityField,
      exitPriceSource,
      warnings,
      legs: legs.map((l, i) => ({
        symbol: l.symbol,
        openSide: l.open_side || 'unknown',
        entryPrice: Number(l.entry_price) || 0,
        exitPrice: Number(l.exit_price) || 0,
        quantity: Number(l.quantity) || 0,
        isPrimary: i === 0,
      })),
    });
  }

  // Print issue summary
  console.log('ISSUE SUMMARY');
  console.log('-'.repeat(60));
  console.log(`qty_equals_legcount:       ${issues.qty_equals_legcount.length}`);
  console.log(`stop_loss_positive_pnl:    ${issues.stop_loss_positive_pnl.length}`);
  console.log(`profit_target_negative_pnl: ${issues.profit_target_negative_pnl.length}`);
  console.log(`missing_entry_credit:      ${issues.missing_entry_credit.length}`);
  console.log(`missing_exit_data:         ${issues.missing_exit_data.length}`);
  console.log(`pnl_mismatch:              ${issues.pnl_mismatch.length}`);
  console.log(`all_legs_same_exit:        ${issues.all_legs_same_exit.length}`);

  // Print detailed truth tables for problematic groups
  console.log('\n' + '='.repeat(80));
  console.log('DETAILED TRUTH TABLES FOR FLAGGED GROUPS');
  console.log('='.repeat(80));

  // Focus on groups with issues
  const flaggedGroups = detailedGroups.filter(g => g.warnings.length > 0);
  console.log(`\nShowing ${flaggedGroups.length} groups with warnings:\n`);

  for (const group of flaggedGroups.slice(0, 20)) { // Limit to 20 for readability
    console.log('-'.repeat(80));
    console.log(`GROUP: ${group.groupId.slice(0, 8)}  |  ${group.underlying}  |  ${group.legCount} legs  |  ${group.closedAt}`);
    console.log(`Exit Reason: ${group.exitReason}  |  Exit Price Source: ${group.exitPriceSource}`);
    console.log(`Quantity Field: ${group.quantityField}  |  Computed Contracts: ${group.contracts}`);
    console.log('');
    console.log('STORED VALUES:');
    console.log(`  entry_credit: $${group.storedEntryCredit.toFixed(2)}`);
    console.log(`  exit_debit:   $${group.storedExitDebit.toFixed(2)}`);
    console.log(`  pnl:          $${group.storedPnl.toFixed(2)}`);
    console.log('');
    console.log('COMPUTED VALUES (using canonical formula):');
    console.log(`  entry_credit: $${group.computedEntryCredit.toFixed(2)}`);
    console.log(`  exit_debit:   $${group.computedExitDebit.toFixed(2)}`);
    console.log(`  pnl:          $${group.computedPnl.toFixed(2)}`);
    console.log('');
    console.log('LEGS:');
    console.log('  Symbol           | Side   | Entry  | Exit   | Qty | Primary');
    for (const leg of group.legs) {
      const symbol = leg.symbol.slice(-15).padEnd(16);
      const side = (leg.openSide === 'sell_to_open' ? 'STO' : 'BTO').padEnd(6);
      const entry = leg.entryPrice.toFixed(2).padStart(6);
      const exit = leg.exitPrice.toFixed(2).padStart(6);
      const qty = leg.quantity.toString().padStart(3);
      const primary = leg.isPrimary ? 'YES' : '   ';
      console.log(`  ${symbol} | ${side} | ${entry} | ${exit} | ${qty} | ${primary}`);
    }
    console.log('');
    console.log('WARNINGS:');
    for (const w of group.warnings) {
      console.log(`  ⚠️  ${w}`);
    }
    console.log('');
  }

  // Print groups where stop_loss shows positive P&L
  if (issues.stop_loss_positive_pnl.length > 0) {
    console.log('\n' + '='.repeat(80));
    console.log('ANALYSIS: STOP_LOSS WITH POSITIVE P&L');
    console.log('='.repeat(80));
    console.log('\nThese trades triggered stop_loss but show positive realized P&L.');
    console.log('This could be:');
    console.log('  A) Correct: stop_loss trigger based on mark prices, but fill was favorable');
    console.log('  B) Bug: P&L calculation is inverted or multiplied incorrectly');
    console.log('  C) Bug: exit_reason attached incorrectly\n');

    for (const groupId of issues.stop_loss_positive_pnl.slice(0, 5)) {
      const g = detailedGroups.find(d => d.groupId === groupId)!;
      console.log(`Group ${groupId.slice(0, 8)}: stored_pnl=$${g.storedPnl.toFixed(2)}, computed_pnl=$${g.computedPnl.toFixed(2)}`);
    }
  }

  // Export to CSV format for further analysis
  console.log('\n' + '='.repeat(80));
  console.log('CSV EXPORT (for spreadsheet analysis)');
  console.log('='.repeat(80));
  console.log('\ngroup_id,underlying,leg_count,exit_reason,stored_pnl,computed_pnl,diff,stored_entry,computed_entry,stored_exit,computed_exit,qty_field,contracts,exit_source,warnings');
  for (const g of detailedGroups) {
    const diff = Math.abs(g.storedPnl - g.computedPnl);
    const warnings = g.warnings.join('|');
    console.log(`${g.groupId.slice(0,8)},${g.underlying},${g.legCount},${g.exitReason},${g.storedPnl.toFixed(2)},${g.computedPnl.toFixed(2)},${diff.toFixed(2)},${g.storedEntryCredit.toFixed(2)},${g.computedEntryCredit.toFixed(2)},${g.storedExitDebit.toFixed(2)},${g.computedExitDebit.toFixed(2)},${g.quantityField},${g.contracts},${g.exitPriceSource},"${warnings}"`);
  }
}

diagnose().catch(console.error);
