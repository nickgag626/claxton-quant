/**
 * COMPREHENSIVE P&L AUDIT SCRIPT
 *
 * Purpose: Validate all closed trade groups and identify discrepancies
 * Mode: READ-ONLY (no database writes)
 *
 * Output: CSV report with computed values, warnings, and recommended fixes
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Load environment
const envPath = join(process.cwd(), '.env');
const envContent = readFileSync(envPath, 'utf-8');
const envVars: Record<string, string> = {};
for (const line of envContent.split(/\r?\n/)) {
  const match = line.match(/^([^=]+)=["']?([^"']*)["']?$/);
  if (match) envVars[match[1].trim()] = match[2].trim();
}

const supabase = createClient(envVars['VITE_SUPABASE_URL'], envVars['VITE_SUPABASE_PUBLISHABLE_KEY']);

// Types
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
  quantity: number;
  close_status: string | null;
  exit_reason: string | null;
  strategy_type: string | null;
  exit_time: string | null;
  needs_reconcile: boolean | null;
}

interface PositionGroupMap {
  trade_group_id: string;
  entry_credit: number | null;
  leg_symbol: string;
  leg_side: string | null;
}

interface AuditResult {
  groupId: string;
  underlying: string;
  legCount: number;
  exitReason: string;
  exitTime: string;

  // Stored values
  storedEntryCredit: number;
  storedExitDebit: number;
  storedPnl: number;
  storedQuantity: number;

  // Computed values using canonical formula
  computedEntryCredit: number;
  computedExitDebit: number;
  computedPnl: number;
  computedContracts: number;

  // Differences
  entryDelta: number;
  exitDelta: number;
  pnlDelta: number;

  // Source detection
  exitPriceSource: 'COMBO_NET_PRIMARY' | 'COMBO_NET_ALL_LEGS' | 'PER_LEG_FILLS' | 'PARTIAL' | 'MISSING';
  entrySource: 'position_group_map' | 'trades_table' | 'computed_from_legs';

  // Warning flags
  warnings: string[];

  // Recommendation
  action: 'OK' | 'FIX_ENTRY_CREDIT' | 'FIX_EXIT_DEBIT' | 'FIX_BOTH' | 'NEEDS_MANUAL_REVIEW';

  // Leg details for debugging
  legs: Array<{
    symbol: string;
    openSide: string;
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    isPrimary: boolean;
  }>;
}

async function runAudit(): Promise<AuditResult[]> {
  console.log('=' .repeat(80));
  console.log('P&L AUDIT REPORT - READ ONLY');
  console.log('=' .repeat(80));
  console.log(`Generated: ${new Date().toISOString()}\n`);

  // Fetch all closed trades
  const { data: allTrades, error } = await supabase
    .from('trades')
    .select('*')
    .not('trade_group_id', 'is', null)
    .eq('close_status', 'filled')
    .order('exit_time', { ascending: false });

  if (error) {
    console.error('Error fetching trades:', error);
    return [];
  }

  // Fetch position_group_map for entry_credit source of truth
  const groupIds = [...new Set((allTrades || []).map(t => t.trade_group_id))];
  const { data: mappings } = await supabase
    .from('position_group_map')
    .select('trade_group_id, entry_credit, leg_symbol, leg_side')
    .in('trade_group_id', groupIds);

  const mappingsByGroup = new Map<string, PositionGroupMap[]>();
  for (const m of (mappings || []) as PositionGroupMap[]) {
    const existing = mappingsByGroup.get(m.trade_group_id) || [];
    existing.push(m);
    mappingsByGroup.set(m.trade_group_id, existing);
  }

  // Group trades by trade_group_id
  const groups = new Map<string, Trade[]>();
  for (const t of (allTrades || []) as Trade[]) {
    if (!groups.has(t.trade_group_id)) groups.set(t.trade_group_id, []);
    groups.get(t.trade_group_id)!.push(t);
  }

  console.log(`Total closed trade groups: ${groups.size}\n`);

  const results: AuditResult[] = [];

  for (const [groupId, legs] of groups) {
    // Sort by symbol for consistent primary leg selection
    legs.sort((a, b) => a.symbol.localeCompare(b.symbol));
    const primary = legs[0];
    const legCount = legs.length;
    const underlying = primary.symbol.replace(/\d.*/, '');

    const warnings: string[] = [];

    // === STEP 1: Determine contracts (with quantity bug detection) ===
    const storedQuantity = Math.abs(primary.quantity || 1);
    let computedContracts = storedQuantity;

    // INVARIANT: For 4-leg spreads, if quantity == legCount, it's likely wrong
    if (legCount >= 4 && storedQuantity === legCount) {
      warnings.push(`QTY_EQUALS_LEGCOUNT: quantity=${storedQuantity} == legCount`);
      computedContracts = 1; // Assume 1 contract
    }

    // === STEP 2: Get entry_credit (prefer position_group_map) ===
    let computedEntryCredit = 0;
    let entrySource: AuditResult['entrySource'] = 'computed_from_legs';

    const groupMappings = mappingsByGroup.get(groupId);
    if (groupMappings && groupMappings.length > 0 && groupMappings[0].entry_credit != null) {
      computedEntryCredit = Number(groupMappings[0].entry_credit);
      entrySource = 'position_group_map';
    } else if (primary.entry_credit != null && primary.entry_credit > 10) {
      // Use stored value if it looks like dollars (> $10)
      computedEntryCredit = Number(primary.entry_credit);
      entrySource = 'trades_table';
    } else {
      // Compute from leg entry prices (direction-aware)
      for (const leg of legs) {
        const entryPrice = Number(leg.entry_price) || 0;
        const legMappings = groupMappings?.filter(m => m.leg_symbol === leg.symbol);
        const legSide = legMappings?.[0]?.leg_side || leg.open_side;

        if (legSide === 'sell_to_open' || legSide === 'short') {
          computedEntryCredit += entryPrice * computedContracts * 100;
        } else if (legSide === 'buy_to_open' || legSide === 'long') {
          computedEntryCredit -= entryPrice * computedContracts * 100;
        }
      }
      entrySource = 'computed_from_legs';
    }

    // === STEP 3: Analyze exit prices and compute exit_debit ===
    const legsWithExit = legs.filter(l => l.exit_price && Number(l.exit_price) > 0);
    const exitPrices = legsWithExit.map(l => Number(l.exit_price));
    const allSameExitPrice = exitPrices.length > 0 &&
      exitPrices.every(p => Math.abs(p - exitPrices[0]) < 0.001);

    let exitPriceSource: AuditResult['exitPriceSource'] = 'MISSING';
    let computedExitDebit = 0;

    if (legsWithExit.length === 0) {
      exitPriceSource = 'MISSING';
      warnings.push('MISSING_EXIT_DATA: No legs have exit prices');
    } else if (allSameExitPrice && legsWithExit.length === legCount) {
      // All legs have same exit price - combo net duplicated
      exitPriceSource = 'COMBO_NET_ALL_LEGS';
      computedExitDebit = exitPrices[0] * computedContracts * 100;
    } else if (legsWithExit.length === 1 && legCount > 1) {
      // Only primary leg has exit price - combo net on primary only
      exitPriceSource = 'COMBO_NET_PRIMARY';
      computedExitDebit = exitPrices[0] * computedContracts * 100;
    } else if (legsWithExit.length === legCount && !allSameExitPrice) {
      // All legs have different prices - per-leg fills
      exitPriceSource = 'PER_LEG_FILLS';
      for (const leg of legs) {
        const exitPrice = Number(leg.exit_price) || 0;
        const legMappings = groupMappings?.filter(m => m.leg_symbol === leg.symbol);
        const legSide = legMappings?.[0]?.leg_side || leg.open_side;

        if (legSide === 'sell_to_open' || legSide === 'short') {
          computedExitDebit += exitPrice * computedContracts * 100; // Pay to close short
        } else if (legSide === 'buy_to_open' || legSide === 'long') {
          computedExitDebit -= exitPrice * computedContracts * 100; // Receive from closing long
        }
      }
    } else {
      exitPriceSource = 'PARTIAL';
      warnings.push(`PARTIAL_EXIT_DATA: ${legsWithExit.length}/${legCount} legs have exit prices`);
    }

    // === STEP 4: Compute P&L ===
    const computedPnl = computedEntryCredit - computedExitDebit;

    // === STEP 5: Compare with stored values ===
    const storedEntryCredit = Number(primary.entry_credit) || 0;
    const storedExitDebit = Number(primary.exit_debit) || 0;
    const storedPnl = Number(primary.pnl) || 0;

    const entryDelta = Math.abs(computedEntryCredit - storedEntryCredit);
    const exitDelta = Math.abs(computedExitDebit - storedExitDebit);
    const pnlDelta = Math.abs(computedPnl - storedPnl);

    // === STEP 6: Classify discrepancies ===
    if (entryDelta > 1) {
      // Check for x4 multiplier bug
      const ratio = storedEntryCredit / computedEntryCredit;
      if (Math.abs(ratio - 4) < 0.1) {
        warnings.push(`ENTRY_CREDIT_4X: stored=${storedEntryCredit.toFixed(2)} is 4x computed=${computedEntryCredit.toFixed(2)}`);
      } else if (Math.abs(ratio - 0.25) < 0.1) {
        warnings.push(`ENTRY_CREDIT_DIV4: stored is 1/4 of computed`);
      } else {
        warnings.push(`ENTRY_MISMATCH: stored=${storedEntryCredit.toFixed(2)}, computed=${computedEntryCredit.toFixed(2)}`);
      }
    }

    if (exitDelta > 1) {
      warnings.push(`EXIT_MISMATCH: stored=${storedExitDebit.toFixed(2)}, computed=${computedExitDebit.toFixed(2)}`);
    }

    if (pnlDelta > 1) {
      warnings.push(`PNL_MISMATCH: stored=${storedPnl.toFixed(2)}, computed=${computedPnl.toFixed(2)}`);
    }

    // Check exit reason vs P&L sign
    const exitReason = primary.exit_reason || 'unknown';
    if (exitReason === 'stop_loss' && storedPnl > 0) {
      warnings.push(`STOP_LOSS_POSITIVE: trigger=stop_loss, realized_pnl=$${storedPnl.toFixed(2)} (may be valid)`);
    }
    if (exitReason === 'profit_target' && storedPnl < 0) {
      warnings.push(`PROFIT_TARGET_NEGATIVE: trigger=profit_target, realized_pnl=$${storedPnl.toFixed(2)} (may be valid)`);
    }

    // === STEP 7: Determine action ===
    let action: AuditResult['action'] = 'OK';

    if (exitPriceSource === 'MISSING') {
      action = 'NEEDS_MANUAL_REVIEW';
    } else if (entryDelta > 1 && exitDelta > 1) {
      action = 'FIX_BOTH';
    } else if (entryDelta > 1) {
      action = 'FIX_ENTRY_CREDIT';
    } else if (exitDelta > 1) {
      action = 'FIX_EXIT_DEBIT';
    }

    results.push({
      groupId,
      underlying,
      legCount,
      exitReason,
      exitTime: primary.exit_time || '',

      storedEntryCredit,
      storedExitDebit,
      storedPnl,
      storedQuantity,

      computedEntryCredit,
      computedExitDebit,
      computedPnl,
      computedContracts,

      entryDelta,
      exitDelta,
      pnlDelta,

      exitPriceSource,
      entrySource,

      warnings,
      action,

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

  return results;
}

function printSummary(results: AuditResult[]) {
  console.log('ISSUE SUMMARY');
  console.log('-'.repeat(60));

  const counts = {
    total: results.length,
    ok: results.filter(r => r.action === 'OK').length,
    fixEntry: results.filter(r => r.action === 'FIX_ENTRY_CREDIT').length,
    fixExit: results.filter(r => r.action === 'FIX_EXIT_DEBIT').length,
    fixBoth: results.filter(r => r.action === 'FIX_BOTH').length,
    needsReview: results.filter(r => r.action === 'NEEDS_MANUAL_REVIEW').length,
  };

  console.log(`Total groups:         ${counts.total}`);
  console.log(`OK (no changes):      ${counts.ok}`);
  console.log(`Fix entry_credit:     ${counts.fixEntry}`);
  console.log(`Fix exit_debit:       ${counts.fixExit}`);
  console.log(`Fix both:             ${counts.fixBoth}`);
  console.log(`Needs manual review:  ${counts.needsReview}`);
  console.log('');

  // Warning breakdown
  const warningCounts: Record<string, number> = {};
  for (const r of results) {
    for (const w of r.warnings) {
      const key = w.split(':')[0];
      warningCounts[key] = (warningCounts[key] || 0) + 1;
    }
  }

  console.log('WARNING BREAKDOWN');
  console.log('-'.repeat(60));
  for (const [key, count] of Object.entries(warningCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`${key}: ${count}`);
  }
  console.log('');
}

function printDetailedReport(results: AuditResult[]) {
  const needsFix = results.filter(r => r.action !== 'OK');

  if (needsFix.length === 0) {
    console.log('All groups are OK - no fixes needed.');
    return;
  }

  console.log('DETAILED ISSUES (first 20)');
  console.log('='.repeat(80));

  for (const r of needsFix.slice(0, 20)) {
    console.log('');
    console.log('-'.repeat(80));
    console.log(`GROUP: ${r.groupId.slice(0, 8)}  |  ${r.underlying}  |  ${r.legCount} legs  |  ${r.exitReason}`);
    console.log(`Action: ${r.action}  |  Exit Source: ${r.exitPriceSource}  |  Entry Source: ${r.entrySource}`);
    console.log('');
    console.log('STORED (current):');
    console.log(`  entry_credit: $${r.storedEntryCredit.toFixed(2)}`);
    console.log(`  exit_debit:   $${r.storedExitDebit.toFixed(2)}`);
    console.log(`  pnl:          $${r.storedPnl.toFixed(2)}`);
    console.log(`  quantity:     ${r.storedQuantity}`);
    console.log('');
    console.log('COMPUTED (canonical):');
    console.log(`  entry_credit: $${r.computedEntryCredit.toFixed(2)}`);
    console.log(`  exit_debit:   $${r.computedExitDebit.toFixed(2)}`);
    console.log(`  pnl:          $${r.computedPnl.toFixed(2)}`);
    console.log(`  contracts:    ${r.computedContracts}`);
    console.log('');
    console.log('DELTAS:');
    console.log(`  entry: $${r.entryDelta.toFixed(2)}, exit: $${r.exitDelta.toFixed(2)}, pnl: $${r.pnlDelta.toFixed(2)}`);
    console.log('');
    console.log('LEGS:');
    for (const leg of r.legs) {
      const pri = leg.isPrimary ? '*' : ' ';
      console.log(`  ${pri} ${leg.symbol.slice(-15)} | ${leg.openSide.slice(0, 3)} | entry=$${leg.entryPrice.toFixed(2)} | exit=$${leg.exitPrice.toFixed(2)}`);
    }
    console.log('');
    console.log('WARNINGS:');
    for (const w of r.warnings) {
      console.log(`  - ${w}`);
    }
  }
}

function exportCsv(results: AuditResult[], filename: string) {
  const headers = [
    'group_id', 'underlying', 'leg_count', 'exit_reason', 'exit_time', 'action',
    'stored_entry', 'stored_exit', 'stored_pnl', 'stored_qty',
    'computed_entry', 'computed_exit', 'computed_pnl', 'computed_contracts',
    'entry_delta', 'exit_delta', 'pnl_delta',
    'exit_source', 'entry_source', 'warnings'
  ];

  const rows = results.map(r => [
    r.groupId.slice(0, 8),
    r.underlying,
    r.legCount,
    r.exitReason,
    r.exitTime,
    r.action,
    r.storedEntryCredit.toFixed(2),
    r.storedExitDebit.toFixed(2),
    r.storedPnl.toFixed(2),
    r.storedQuantity,
    r.computedEntryCredit.toFixed(2),
    r.computedExitDebit.toFixed(2),
    r.computedPnl.toFixed(2),
    r.computedContracts,
    r.entryDelta.toFixed(2),
    r.exitDelta.toFixed(2),
    r.pnlDelta.toFixed(2),
    r.exitPriceSource,
    r.entrySource,
    `"${r.warnings.join('|')}"`,
  ].join(','));

  const csv = [headers.join(','), ...rows].join('\n');
  writeFileSync(filename, csv);
  console.log(`CSV exported to: ${filename}`);
}

async function main() {
  const results = await runAudit();

  if (results.length === 0) {
    console.log('No data to audit.');
    return;
  }

  printSummary(results);
  printDetailedReport(results);

  // Export CSV for spreadsheet analysis
  const csvPath = join(process.cwd(), 'pnl-audit-report.csv');
  exportCsv(results, csvPath);

  // Print fix candidates
  const fixable = results.filter(r => r.action !== 'OK' && r.action !== 'NEEDS_MANUAL_REVIEW');
  console.log('');
  console.log('='.repeat(80));
  console.log(`FIXABLE GROUPS: ${fixable.length}`);
  console.log('Run with --apply to apply fixes (not implemented - manual review required)');
}

main().catch(console.error);
