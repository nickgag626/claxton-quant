import { useMemo, useState } from 'react';
import { getCloseInstruction } from '@/lib/closeInstruction';

const cases = [
  {
    name: 'short option qty=-53',
    symbol: 'SPY260112C00696000',
    pos: { quantity: -53, cost_basis: -551.99, instrument_type: 'option' },
    expected: { closeSide: 'buy_to_close', closeQty: 53 },
  },
  {
    name: 'long option qty=53',
    symbol: 'SPY260112C00697000',
    pos: { quantity: 53, cost_basis: 214, instrument_type: 'option' },
    expected: { closeSide: 'sell_to_close', closeQty: 53 },
  },
  {
    name: 'short equity qty=-100',
    symbol: 'SPY',
    pos: { quantity: -100, cost_basis: -100, instrument_type: 'equity' },
    expected: { closeSide: 'buy_to_cover', closeQty: 100 },
  },
  {
    name: 'long equity qty=100',
    symbol: 'SPY',
    pos: { quantity: 100, cost_basis: 100, instrument_type: 'equity' },
    expected: { closeSide: 'sell', closeQty: 100 },
  },
] as const;

export default function CloseInstructionTest() {
  const [json, setJson] = useState('');

  const parsed = useMemo(() => {
    if (!json.trim()) return null;
    try {
      return JSON.parse(json);
    } catch {
      return { __parse_error: true };
    }
  }, [json]);

  const computed = useMemo(() => {
    if (!parsed || (parsed as any).__parse_error) return null;
    const symbol = (parsed as any).symbol || 'UNKNOWN';
    return getCloseInstruction(parsed as any, symbol);
  }, [parsed]);

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="text-xl font-semibold">Close Instruction Test Harness</h1>
          <p className="text-sm text-muted-foreground">
            Verifies the getCloseInstruction() truth table (frontend harness).
          </p>
        </header>

        <section className="rounded border border-border p-4">
          <h2 className="text-sm font-semibold mb-3">Fixed test cases</h2>
          <div className="space-y-2">
            {cases.map((c) => {
              const out = getCloseInstruction(c.pos as any, c.symbol);
              const pass =
                out.ok &&
                out.closeSide === c.expected.closeSide &&
                out.closeQty === c.expected.closeQty;

              return (
                <div key={c.name} className="flex items-center justify-between gap-4 text-sm">
                  <div className="font-mono">{c.name}</div>
                  <div className="font-mono text-muted-foreground">
                    {out.ok ? `${out.closeSide} ${out.closeQty}` : `ERR: ${out.error}`}
                  </div>
                  <div className="font-mono">{pass ? 'PASS' : 'FAIL'}</div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded border border-border p-4">
          <h2 className="text-sm font-semibold mb-3">Paste a Tradier position JSON</h2>
          <textarea
            className="w-full min-h-40 rounded border border-border bg-background p-2 font-mono text-xs"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            placeholder='{"symbol":"SPY260112C00696000","quantity":-53,"cost_basis":-551.99,"instrument_type":"option"}'
          />

          <div className="mt-3">
            <h3 className="text-sm font-semibold">Output</h3>
            <pre className="mt-2 max-h-64 overflow-auto rounded border border-border bg-secondary/30 p-2 text-[10px] whitespace-pre-wrap break-words">
{computed ? JSON.stringify(computed, null, 2) : '—'}
            </pre>
          </div>
        </section>
      </div>
    </div>
  );
}
