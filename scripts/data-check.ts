/**
 * DATA CHECK: Show 50 most recent closed trade groups with key columns
 * Checks if new columns exist and shows their population status
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
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

async function main() {
  console.log('='.repeat(120));
  console.log('DATA CHECK: 50 Most Recent Closed Trade Groups');
  console.log('='.repeat(120));
  console.log(`Generated: ${new Date().toISOString()}\n`);

  // Fetch 50 most recent closed trades grouped
  const { data: trades, error } = await supabase
    .from('trades')
    .select('*')
    .not('trade_group_id', 'is', null)
    .eq('close_status', 'filled')
    .order('exit_time', { ascending: false })
    .limit(200); // Get more to ensure we cover 50 groups

  if (error) {
    console.error('Error:', error);
    return;
  }

  // Group by trade_group_id
  const groups = new Map<string, any[]>();
  for (const t of trades || []) {
    if (!groups.has(t.trade_group_id)) groups.set(t.trade_group_id, []);
    groups.get(t.trade_group_id)!.push(t);
  }

  console.log(`Total groups found: ${groups.size}\n`);

  // Check for new columns existence by looking at first trade
  const sampleTrade = trades?.[0];
  const newColumns = ['exit_price_source', 'exit_trigger_reason', 'contracts', 'leg_count'];

  console.log('NEW COLUMN EXISTENCE CHECK:');
  console.log('-'.repeat(60));
  for (const col of newColumns) {
    const exists = sampleTrade && col in sampleTrade;
    const value = exists ? sampleTrade[col] : 'N/A';
    console.log(`  ${col}: ${exists ? 'EXISTS' : 'MISSING'} (sample value: ${value})`);
  }
  console.log('');

  // Print header
  const header = [
    'group_id'.padEnd(10),
    'under'.padEnd(5),
    'exit_reason'.padEnd(15),
    'exit_trigger_reason'.padEnd(20),
    'exit_price_source'.padEnd(18),
    'contracts'.padEnd(10),
    'qty'.padEnd(5),
    'pnl'.padEnd(10),
    'entry_credit'.padEnd(12),
    'exit_debit'.padEnd(12),
    'exit_prices'.padEnd(20),
  ].join(' | ');

  console.log('DATA TABLE (50 most recent groups):');
  console.log('-'.repeat(header.length));
  console.log(header);
  console.log('-'.repeat(header.length));

  let count = 0;
  for (const [groupId, legs] of groups) {
    if (count >= 50) break;
    count++;

    legs.sort((a, b) => a.symbol.localeCompare(b.symbol));
    const primary = legs[0];
    const underlying = primary.symbol.replace(/\d.*/, '');

    // Count legs with exit prices
    const legsWithExit = legs.filter(l => l.exit_price && Number(l.exit_price) > 0).length;
    const exitPricesInfo = `${legsWithExit}/${legs.length} legs`;

    const row = [
      groupId.slice(0, 8).padEnd(10),
      underlying.padEnd(5),
      (primary.exit_reason || 'null').slice(0, 15).padEnd(15),
      (primary.exit_trigger_reason || 'null').slice(0, 20).padEnd(20),
      (primary.exit_price_source || 'null').slice(0, 18).padEnd(18),
      (primary.contracts?.toString() || 'null').padEnd(10),
      primary.quantity.toString().padEnd(5),
      (primary.pnl?.toFixed(2) || 'null').padEnd(10),
      (primary.entry_credit?.toFixed(2) || 'null').padEnd(12),
      (primary.exit_debit?.toFixed(2) || 'null').padEnd(12),
      exitPricesInfo.padEnd(20),
    ].join(' | ');

    console.log(row);
  }

  console.log('-'.repeat(header.length));

  // Summary counts
  let nullExitTriggerReason = 0;
  let nullExitPriceSource = 0;
  let nullContracts = 0;
  let qtyEqualsLegCount = 0;

  for (const [, legs] of groups) {
    const primary = legs[0];
    if (primary.exit_trigger_reason === null || primary.exit_trigger_reason === undefined) nullExitTriggerReason++;
    if (primary.exit_price_source === null || primary.exit_price_source === undefined) nullExitPriceSource++;
    if (primary.contracts === null || primary.contracts === undefined) nullContracts++;
    if (legs.length >= 4 && primary.quantity === legs.length) qtyEqualsLegCount++;
  }

  console.log('\nPOPULATION SUMMARY (all groups):');
  console.log('-'.repeat(60));
  console.log(`  exit_trigger_reason NULL: ${nullExitTriggerReason}/${groups.size}`);
  console.log(`  exit_price_source NULL:   ${nullExitPriceSource}/${groups.size}`);
  console.log(`  contracts NULL:           ${nullContracts}/${groups.size}`);
  console.log(`  quantity==legCount bug:   ${qtyEqualsLegCount}/${groups.size}`);
}

main().catch(console.error);
