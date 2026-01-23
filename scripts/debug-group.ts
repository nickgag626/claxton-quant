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

async function debug() {
  // Find the group with entry_credit=548, exit_debit=556
  const { data: match } = await supabase
    .from('trades')
    .select('trade_group_id')
    .eq('entry_credit', 548)
    .eq('exit_debit', 556)
    .limit(1);

  if (!match || match.length === 0) {
    console.log('Group not found');
    return;
  }

  const groupId = match[0].trade_group_id;
  console.log('Group ID:', groupId);

  const { data: legs } = await supabase
    .from('trades')
    .select('symbol, entry_price, exit_price, open_side, quantity, entry_credit, exit_debit, pnl')
    .eq('trade_group_id', groupId)
    .order('symbol');

  console.log('\nAll legs:');
  for (const l of legs || []) {
    console.log(`${l.symbol.slice(-8)}: entry=${l.entry_price}, exit=${l.exit_price}, qty=${l.quantity}, side=${l.open_side}`);
  }

  // Calculate what exit_debit SHOULD be
  const exitPrices = (legs || []).map(l => l.exit_price).filter(p => p && p > 0);
  console.log('\nExit prices:', exitPrices);

  if (exitPrices.length > 0) {
    const allSame = exitPrices.every(p => Math.abs(p - exitPrices[0]) < 0.01);
    console.log('All same?', allSame);

    if (allSame) {
      const correctDebit = exitPrices[0] * 1 * 100;
      console.log('Correct exit_debit (combo fill):', correctDebit);
    }
  }
}

debug().catch(console.error);
