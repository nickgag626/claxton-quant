/**
 * INTEGRATION AUDIT: Detailed analysis of 200 most recent closed groups
 * - Computes canonical entry/exit/pnl
 * - Detects x4 multiplier bug
 * - Infers exit source
 * - Outputs CSV + summary
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const envPath = join(process.cwd(), '.env');
const envContent = readFileSync(envPath, 'utf-8');
const envVars: Record<string, string> = {};
for (const line of envContent.split(/\r?\n/)) {
  const match = line.match(/^([^=]+)=["']?([^"']*)["']?$/);
  if (match) envVars[match[1].trim()] = match[2].trim();
}

const supabase = createClient(envVars['VITE_SUPABASE_URL'], envVars['VITE_SUPABASE_PUBLISHABLE_KEY']);

interface GroupAnalysis {
  groupId: string;
  underlying: string;
  legCount: number;
  exitReason: string;
  exitTime: string;

  // Stored values
  storedEntry: number;
  storedExit: number;
  storedPnl: number;
  storedQty: number;

  // Computed values
  computedEntry: number;
  computedExit: number;
  computedPnl: number;
  computedContracts: number;

  // Inferred exit source
  exitSource: 'PER_LEG' | 'COMBO_NET' | 'PARTIAL' | 'MISSING';

  // x4 detection
  entryRatio: number; // stored/computed
  x4Bug: 'x4_entry' | 'div4_entry' | 'x4_exit' | 'div4_exit' | 'none';

  // Flags
  qtyEqualsLegCount: boolean;
  stopLossPositive: boolean;
  profitTargetNegative: boolean;
}

async function runIntegrationAudit(): Promise<GroupAnalysis[]> {
  console.log('='.repeat(80));
  console.log('INTEGRATION AUDIT: 200 Most Recent Closed Groups');
  console.log('='.repeat(80));
  console.log(`Generated: ${new Date().toISOString()}\n`);

  // Fetch trades
  const { data: allTrades, error } = await supabase
    .from('trades')
    .select('*')
    .not('trade_group_id', 'is', null)
    .eq('close_status', 'filled')
    .order('exit_time', { ascending: false })
    .limit(800);

  if (error) {
    console.error('Error:', error);
    return [];
  }

  // Fetch position_group_map
  const groupIds = [...new Set((allTrades || []).map(t => t.trade_group_id))];
  const { data: mappings } = await supabase
    .from('position_group_map')
    .select('trade_group_id, entry_credit, leg_symbol, leg_side')
    .in('trade_group_id', groupIds);

  const mappingsByGroup = new Map<string, any[]>();
  for (const m of mappings || []) {
    const existing = mappingsByGroup.get(m.trade_group_id) || [];
    existing.push(m);
    mappingsByGroup.set(m.trade_group_id, existing);
  }

  // Group trades
  const groups = new Map<string, any[]>();
  for (const t of allTrades || []) {
    if (!groups.has(t.trade_group_id)) groups.set(t.trade_group_id, []);
    groups.get(t.trade_group_id)!.push(t);
  }

  const results: GroupAnalysis[] = [];
  let count = 0;

  for (const [groupId, legs] of groups) {
    if (count >= 200) break;
    count++;

    legs.sort((a, b) => a.symbol.localeCompare(b.symbol));
    const primary = legs[0];
    const legCount = legs.length;
    const underlying = primary.symbol.replace(/\d.*/, '');
    const groupMappings = mappingsByGroup.get(groupId);

    // Stored values
    const storedQty = Math.abs(primary.quantity || 1);
    const storedEntry = Number(primary.entry_credit) || 0;
    const storedExit = Number(primary.exit_debit) || 0;
    const storedPnl = Number(primary.pnl) || 0;

    // Compute contracts (fix qty==legCount bug)
    const qtyEqualsLegCount = legCount >= 4 && storedQty === legCount;
    const computedContracts = qtyEqualsLegCount ? 1 : storedQty;

    // Get entry_credit from position_group_map or trades
    let computedEntry = 0;
    if (groupMappings?.[0]?.entry_credit != null) {
      computedEntry = Number(groupMappings[0].entry_credit);
    } else if (storedEntry > 10) {
      computedEntry = storedEntry;
    } else {
      // Compute from legs
      for (const leg of legs) {
        const entryPrice = Number(leg.entry_price) || 0;
        const legMapping = groupMappings?.find(m => m.leg_symbol === leg.symbol);
        const legSide = legMapping?.leg_side || leg.open_side;
        if (legSide === 'sell_to_open') {
          computedEntry += entryPrice * computedContracts * 100;
        } else if (legSide === 'buy_to_open') {
          computedEntry -= entryPrice * computedContracts * 100;
        }
      }
    }

    // Analyze exit prices
    const legsWithExit = legs.filter(l => l.exit_price && Number(l.exit_price) > 0);
    const exitPrices = legsWithExit.map(l => Number(l.exit_price));
    const allSame = exitPrices.length > 0 && exitPrices.every(p => Math.abs(p - exitPrices[0]) < 0.001);

    let exitSource: GroupAnalysis['exitSource'] = 'MISSING';
    let computedExit = 0;

    if (legsWithExit.length === 0) {
      exitSource = 'MISSING';
    } else if (allSame && legsWithExit.length === legCount) {
      exitSource = 'COMBO_NET';
      computedExit = exitPrices[0] * computedContracts * 100;
    } else if (legsWithExit.length === 1 && legCount > 1) {
      exitSource = 'COMBO_NET';
      computedExit = exitPrices[0] * computedContracts * 100;
    } else if (legsWithExit.length === legCount && !allSame) {
      exitSource = 'PER_LEG';
      for (const leg of legs) {
        const exitPrice = Number(leg.exit_price) || 0;
        const legMapping = groupMappings?.find(m => m.leg_symbol === leg.symbol);
        const legSide = legMapping?.leg_side || leg.open_side;
        if (legSide === 'sell_to_open') {
          computedExit += exitPrice * computedContracts * 100;
        } else if (legSide === 'buy_to_open') {
          computedExit -= exitPrice * computedContracts * 100;
        }
      }
    } else {
      exitSource = 'PARTIAL';
    }

    const computedPnl = computedEntry - computedExit;

    // x4 detection
    const entryRatio = computedEntry > 0 ? storedEntry / computedEntry : 0;
    let x4Bug: GroupAnalysis['x4Bug'] = 'none';
    if (Math.abs(entryRatio - 4) < 0.15) x4Bug = 'x4_entry';
    else if (Math.abs(entryRatio - 0.25) < 0.05) x4Bug = 'div4_entry';

    const exitRatio = computedExit > 0 ? storedExit / computedExit : 0;
    if (Math.abs(exitRatio - 4) < 0.15) x4Bug = 'x4_exit';
    else if (Math.abs(exitRatio - 0.25) < 0.05) x4Bug = 'div4_exit';

    // Exit reason flags
    const exitReason = primary.exit_reason || 'unknown';
    const stopLossPositive = exitReason === 'stop_loss' && storedPnl > 0;
    const profitTargetNegative = exitReason === 'profit_target' && storedPnl < 0;

    results.push({
      groupId,
      underlying,
      legCount,
      exitReason,
      exitTime: primary.exit_time || '',
      storedEntry,
      storedExit,
      storedPnl,
      storedQty,
      computedEntry,
      computedExit,
      computedPnl,
      computedContracts,
      exitSource,
      entryRatio,
      x4Bug,
      qtyEqualsLegCount,
      stopLossPositive,
      profitTargetNegative,
    });
  }

  return results;
}

function printSummary(results: GroupAnalysis[]) {
  console.log('SUMMARY COUNTS');
  console.log('-'.repeat(60));

  const counts = {
    total: results.length,
    qtyEqualsLegCount: results.filter(r => r.qtyEqualsLegCount).length,
    stopLossPositive: results.filter(r => r.stopLossPositive).length,
    profitTargetNegative: results.filter(r => r.profitTargetNegative).length,
    x4Entry: results.filter(r => r.x4Bug === 'x4_entry').length,
    div4Entry: results.filter(r => r.x4Bug === 'div4_entry').length,
    x4Exit: results.filter(r => r.x4Bug === 'x4_exit').length,
    div4Exit: results.filter(r => r.x4Bug === 'div4_exit').length,
    exitSourceComboNet: results.filter(r => r.exitSource === 'COMBO_NET').length,
    exitSourcePerLeg: results.filter(r => r.exitSource === 'PER_LEG').length,
    exitSourcePartial: results.filter(r => r.exitSource === 'PARTIAL').length,
    exitSourceMissing: results.filter(r => r.exitSource === 'MISSING').length,
  };

  console.log(`Total groups analyzed:      ${counts.total}`);
  console.log('');
  console.log('QUANTITY/CONTRACTS BUG:');
  console.log(`  qty==legCount:            ${counts.qtyEqualsLegCount}`);
  console.log('');
  console.log('EXIT TRIGGER VS REALIZED (slippage):');
  console.log(`  stop_loss + positive PnL: ${counts.stopLossPositive}`);
  console.log(`  profit_target + negative: ${counts.profitTargetNegative}`);
  console.log('');
  console.log('x4 MULTIPLIER BUG:');
  console.log(`  x4_entry (stored ~4x):    ${counts.x4Entry}`);
  console.log(`  div4_entry (stored ~1/4): ${counts.div4Entry}`);
  console.log(`  x4_exit:                  ${counts.x4Exit}`);
  console.log(`  div4_exit:                ${counts.div4Exit}`);
  console.log('');
  console.log('EXIT PRICE SOURCE:');
  console.log(`  COMBO_NET:                ${counts.exitSourceComboNet}`);
  console.log(`  PER_LEG:                  ${counts.exitSourcePerLeg}`);
  console.log(`  PARTIAL:                  ${counts.exitSourcePartial}`);
  console.log(`  MISSING:                  ${counts.exitSourceMissing}`);
}

function exportCsv(results: GroupAnalysis[], filename: string) {
  const headers = [
    'group_id', 'underlying', 'leg_count', 'exit_reason', 'exit_time',
    'stored_entry', 'stored_exit', 'stored_pnl', 'stored_qty',
    'computed_entry', 'computed_exit', 'computed_pnl', 'computed_contracts',
    'exit_source', 'entry_ratio', 'x4_bug',
    'qty_equals_legcount', 'stop_loss_positive', 'profit_target_negative'
  ];

  const rows = results.map(r => [
    r.groupId.slice(0, 8),
    r.underlying,
    r.legCount,
    r.exitReason,
    r.exitTime,
    r.storedEntry.toFixed(2),
    r.storedExit.toFixed(2),
    r.storedPnl.toFixed(2),
    r.storedQty,
    r.computedEntry.toFixed(2),
    r.computedExit.toFixed(2),
    r.computedPnl.toFixed(2),
    r.computedContracts,
    r.exitSource,
    r.entryRatio.toFixed(2),
    r.x4Bug,
    r.qtyEqualsLegCount,
    r.stopLossPositive,
    r.profitTargetNegative,
  ].join(','));

  const csv = [headers.join(','), ...rows].join('\n');
  writeFileSync(filename, csv);
  console.log(`\nCSV exported to: ${filename}`);
}

async function main() {
  const results = await runIntegrationAudit();
  if (results.length === 0) {
    console.log('No data.');
    return;
  }

  printSummary(results);
  exportCsv(results, join(process.cwd(), 'integration-audit.csv'));

  // Show first 10 with issues
  const issues = results.filter(r => r.x4Bug !== 'none' || r.qtyEqualsLegCount);
  console.log('\n' + '='.repeat(80));
  console.log(`GROUPS WITH X4 BUG OR QTY==LEGCOUNT (${issues.length} total, showing first 10):`);
  console.log('-'.repeat(80));

  for (const r of issues.slice(0, 10)) {
    console.log(`${r.groupId.slice(0,8)} | ${r.underlying} | legs=${r.legCount} | qty=${r.storedQty}`);
    console.log(`  stored:   entry=$${r.storedEntry.toFixed(2)}, exit=$${r.storedExit.toFixed(2)}, pnl=$${r.storedPnl.toFixed(2)}`);
    console.log(`  computed: entry=$${r.computedEntry.toFixed(2)}, exit=$${r.computedExit.toFixed(2)}, pnl=$${r.computedPnl.toFixed(2)}`);
    console.log(`  ratio=${r.entryRatio.toFixed(2)} x4_bug=${r.x4Bug} qty==legCount=${r.qtyEqualsLegCount}`);
    console.log('');
  }
}

main().catch(console.error);
