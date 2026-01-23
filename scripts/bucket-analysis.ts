/**
 * BUCKET ANALYSIS - READ ONLY
 *
 * For each stop_loss_positive and profit_target_negative trade:
 * - Fetch strategy_evaluations at exit_attempt
 * - Compare mark-based trigger P&L vs realized fill P&L
 * - Assign to bucket A (slippage), B (wrong reason), or C (calculation bug)
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

interface BucketResult {
  groupId: string;
  underlying: string;
  exitReason: string;
  exitTime: string;

  // From strategy_evaluations at exit
  evalFound: boolean;
  triggerPnlPercent: number | null;
  triggerCostToClose: number | null;
  triggerEntryCredit: number | null;
  triggerDecision: string | null;

  // From trades at fill
  storedEntryCredit: number;
  storedExitDebit: number;
  storedPnl: number;
  storedQuantity: number;
  legCount: number;

  // Leg details
  legExitPrices: number[];
  allSameExitPrice: boolean;

  // Bucket assignment
  bucket: 'A' | 'B' | 'C' | 'UNKNOWN';
  bucketProof: string;
}

async function analyzeBuckets() {
  console.log('=' .repeat(80));
  console.log('BUCKET ANALYSIS - READ ONLY');
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

  // Group by trade_group_id
  const groups = new Map<string, any[]>();
  for (const t of allTrades || []) {
    if (!groups.has(t.trade_group_id)) groups.set(t.trade_group_id, []);
    groups.get(t.trade_group_id)!.push(t);
  }

  // Identify flagged groups
  const flaggedGroups: Array<{ groupId: string; type: 'stop_loss_positive' | 'profit_target_negative' }> = [];

  for (const [groupId, legs] of groups) {
    legs.sort((a: any, b: any) => a.symbol.localeCompare(b.symbol));
    const primary = legs[0];
    const storedPnl = Number(primary.pnl) || 0;
    const exitReason = primary.exit_reason || '';

    if (exitReason === 'stop_loss' && storedPnl > 0) {
      flaggedGroups.push({ groupId, type: 'stop_loss_positive' });
    }
    if (exitReason === 'profit_target' && storedPnl < 0) {
      flaggedGroups.push({ groupId, type: 'profit_target_negative' });
    }
  }

  console.log(`Found ${flaggedGroups.length} flagged groups to analyze\n`);
  console.log(`- stop_loss with positive P&L: ${flaggedGroups.filter(g => g.type === 'stop_loss_positive').length}`);
  console.log(`- profit_target with negative P&L: ${flaggedGroups.filter(g => g.type === 'profit_target_negative').length}`);
  console.log('');

  const results: BucketResult[] = [];

  for (const { groupId, type } of flaggedGroups) {
    const legs = groups.get(groupId)!;
    legs.sort((a: any, b: any) => a.symbol.localeCompare(b.symbol));
    const primary = legs[0];
    const underlying = primary.symbol.replace(/\d.*/, '');

    // Fetch strategy_evaluations for this group at exit
    const { data: evals } = await supabase
      .from('strategy_evaluations')
      .select('*')
      .eq('trade_group_id', groupId)
      .in('event_type', ['exit_attempt', 'exit_triggered', 'close_order_placed'])
      .order('created_at', { ascending: false })
      .limit(5);

    // Find the evaluation that triggered the exit
    let triggerEval: any = null;
    let triggerPnlPercent: number | null = null;
    let triggerCostToClose: number | null = null;
    let triggerEntryCredit: number | null = null;
    let triggerDecision: string | null = null;

    if (evals && evals.length > 0) {
      // Look for the evaluation that shows the trigger decision
      for (const ev of evals) {
        const inputs = ev.inputs_json || {};
        const gates = ev.gates_json || [];

        // Extract P&L info from inputs.market (where it's actually stored)
        if (inputs.market?.pnl_percent != null && triggerPnlPercent == null) {
          triggerPnlPercent = inputs.market.pnl_percent;
        }
        if (inputs.market?.pnl_dollars != null && triggerCostToClose == null) {
          // pnl_dollars is unrealized P&L, not cost_to_close
          // But we can derive: cost_to_close = entry_credit - pnl_dollars
        }

        // Also check gates for P&L data
        for (const gate of gates) {
          const actual = gate.actual || {};
          if (actual.pnl_percent != null && triggerPnlPercent == null) {
            triggerPnlPercent = actual.pnl_percent;
          }
          if (actual.pnl_dollars != null) {
            // Store for reference
          }
          if (actual.cost_to_close != null && triggerCostToClose == null) {
            triggerCostToClose = actual.cost_to_close;
          }
          if (actual.entry_credit_dollars != null && triggerEntryCredit == null) {
            triggerEntryCredit = actual.entry_credit_dollars;
          }
        }

        if (ev.decision) {
          triggerDecision = ev.decision;
          triggerEval = ev;
        }
      }
    }

    // Get stored values from trades
    const storedEntryCredit = Number(primary.entry_credit) || 0;
    const storedExitDebit = Number(primary.exit_debit) || 0;
    const storedPnl = Number(primary.pnl) || 0;
    const storedQuantity = Number(primary.quantity) || 1;
    const legCount = legs.length;

    // Analyze exit prices
    const legExitPrices = legs.map((l: any) => Number(l.exit_price) || 0).filter((p: number) => p > 0);
    const allSameExitPrice = legExitPrices.length > 0 &&
      legExitPrices.every((p: number) => Math.abs(p - legExitPrices[0]) < 0.001);

    // Determine bucket
    let bucket: 'A' | 'B' | 'C' | 'UNKNOWN' = 'UNKNOWN';
    let bucketProof = '';

    if (triggerPnlPercent != null) {
      // We have trigger P&L data - can compare with realized
      const realizedPnlPercent = storedEntryCredit > 0
        ? (storedPnl / storedEntryCredit) * 100
        : 0;

      if (type === 'stop_loss_positive') {
        // stop_loss triggered, but realized is positive
        if (triggerPnlPercent < 0 && realizedPnlPercent > 0) {
          // Trigger was negative (correct), but fill was positive (slippage)
          bucket = 'A';
          bucketProof = `Trigger P&L=${triggerPnlPercent.toFixed(1)}% (negative, correct), Realized=${realizedPnlPercent.toFixed(1)}% (positive, slippage)`;
        } else if (triggerPnlPercent > 0) {
          // Trigger was positive but still fired stop_loss - wrong reason
          bucket = 'B';
          bucketProof = `Trigger P&L=${triggerPnlPercent.toFixed(1)}% was POSITIVE, shouldn't fire stop_loss`;
        } else {
          bucket = 'C';
          bucketProof = `Trigger calc may be wrong: trigger=${triggerPnlPercent.toFixed(1)}%, realized=${realizedPnlPercent.toFixed(1)}%`;
        }
      } else {
        // profit_target triggered, but realized is negative
        if (triggerPnlPercent > 0 && realizedPnlPercent < 0) {
          // Trigger was positive (correct), but fill was negative (slippage)
          bucket = 'A';
          bucketProof = `Trigger P&L=${triggerPnlPercent.toFixed(1)}% (positive, correct), Realized=${realizedPnlPercent.toFixed(1)}% (negative, slippage)`;
        } else if (triggerPnlPercent < 0) {
          // Trigger was negative but still fired profit_target - wrong reason
          bucket = 'B';
          bucketProof = `Trigger P&L=${triggerPnlPercent.toFixed(1)}% was NEGATIVE, shouldn't fire profit_target`;
        } else {
          bucket = 'C';
          bucketProof = `Trigger calc may be wrong: trigger=${triggerPnlPercent.toFixed(1)}%, realized=${realizedPnlPercent.toFixed(1)}%`;
        }
      }
    } else {
      // No trigger P&L data - check for quantity bug
      if (storedQuantity === legCount && legCount === 4) {
        bucket = 'C';
        bucketProof = `quantity=${storedQuantity} == legCount=${legCount}, likely x4 bug`;
      } else if (allSameExitPrice && legExitPrices.length === legCount) {
        // All legs have same exit price - combo fill potentially mishandled
        bucket = 'C';
        bucketProof = `All ${legCount} legs have same exit_price=${legExitPrices[0]}, may be combo misinterpretation`;
      } else {
        bucket = 'UNKNOWN';
        bucketProof = `No strategy_evaluation data found to prove trigger P&L`;
      }
    }

    results.push({
      groupId,
      underlying,
      exitReason: primary.exit_reason || 'unknown',
      exitTime: primary.exit_time || '',

      evalFound: triggerEval != null,
      triggerPnlPercent,
      triggerCostToClose,
      triggerEntryCredit,
      triggerDecision,

      storedEntryCredit,
      storedExitDebit,
      storedPnl,
      storedQuantity,
      legCount,

      legExitPrices,
      allSameExitPrice,

      bucket,
      bucketProof,
    });
  }

  return results;
}

function printReport(results: BucketResult[]) {
  // Count by bucket
  const bucketCounts = {
    A: results.filter(r => r.bucket === 'A').length,
    B: results.filter(r => r.bucket === 'B').length,
    C: results.filter(r => r.bucket === 'C').length,
    UNKNOWN: results.filter(r => r.bucket === 'UNKNOWN').length,
  };

  console.log('\nBUCKET SUMMARY');
  console.log('-'.repeat(60));
  console.log(`BUCKET A (slippage - trigger correct, fill different): ${bucketCounts.A}`);
  console.log(`BUCKET B (wrong reason - trigger shouldn't have fired): ${bucketCounts.B}`);
  console.log(`BUCKET C (calculation bug - sign/unit/quantity error):  ${bucketCounts.C}`);
  console.log(`UNKNOWN (insufficient data to determine):               ${bucketCounts.UNKNOWN}`);
  console.log('');

  // Detailed report
  console.log('DETAILED ANALYSIS');
  console.log('='.repeat(80));

  for (const r of results) {
    console.log('');
    console.log('-'.repeat(80));
    console.log(`GROUP: ${r.groupId.slice(0, 8)} | ${r.underlying} | ${r.exitReason} | BUCKET ${r.bucket}`);
    console.log(`Exit Time: ${r.exitTime}`);
    console.log('');
    console.log('STRATEGY EVALUATION (trigger time):');
    console.log(`  Found: ${r.evalFound ? 'YES' : 'NO'}`);
    console.log(`  Trigger P&L%: ${r.triggerPnlPercent?.toFixed(2) ?? 'N/A'}`);
    console.log(`  Cost-to-close: $${r.triggerCostToClose?.toFixed(2) ?? 'N/A'}`);
    console.log(`  Entry credit: $${r.triggerEntryCredit?.toFixed(2) ?? 'N/A'}`);
    console.log('');
    console.log('TRADES (fill time):');
    console.log(`  entry_credit: $${r.storedEntryCredit.toFixed(2)}`);
    console.log(`  exit_debit: $${r.storedExitDebit.toFixed(2)}`);
    console.log(`  pnl: $${r.storedPnl.toFixed(2)}`);
    console.log(`  quantity: ${r.storedQuantity} | legCount: ${r.legCount}`);
    console.log(`  exit_prices: [${r.legExitPrices.map(p => p.toFixed(2)).join(', ')}]`);
    console.log(`  all_same_exit_price: ${r.allSameExitPrice}`);
    console.log('');
    console.log(`BUCKET: ${r.bucket}`);
    console.log(`PROOF: ${r.bucketProof}`);
  }

  // CSV export
  console.log('\n' + '='.repeat(80));
  console.log('CSV EXPORT');
  console.log('='.repeat(80));
  console.log('group_id,underlying,exit_reason,exit_time,bucket,proof,trigger_pnl_pct,stored_pnl,stored_entry,stored_exit,qty,legs');

  for (const r of results) {
    console.log([
      r.groupId.slice(0, 8),
      r.underlying,
      r.exitReason,
      r.exitTime.slice(0, 19),
      r.bucket,
      `"${r.bucketProof}"`,
      r.triggerPnlPercent?.toFixed(2) ?? 'N/A',
      r.storedPnl.toFixed(2),
      r.storedEntryCredit.toFixed(2),
      r.storedExitDebit.toFixed(2),
      r.storedQuantity,
      r.legCount,
    ].join(','));
  }
}

async function main() {
  const results = await analyzeBuckets();
  printReport(results);

  // Save to file
  const csvPath = join(process.cwd(), 'bucket-analysis.csv');
  const csvHeaders = 'group_id,underlying,exit_reason,exit_time,bucket,proof,trigger_pnl_pct,stored_pnl,stored_entry,stored_exit,qty,legs\n';
  const csvRows = results.map(r => [
    r.groupId.slice(0, 8),
    r.underlying,
    r.exitReason,
    r.exitTime.slice(0, 19),
    r.bucket,
    `"${r.bucketProof}"`,
    r.triggerPnlPercent?.toFixed(2) ?? 'N/A',
    r.storedPnl.toFixed(2),
    r.storedEntryCredit.toFixed(2),
    r.storedExitDebit.toFixed(2),
    r.storedQuantity,
    r.legCount,
  ].join(',')).join('\n');

  writeFileSync(csvPath, csvHeaders + csvRows);
  console.log(`\nCSV saved to: ${csvPath}`);
}

main().catch(console.error);
