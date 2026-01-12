export type InstrumentType = 'option' | 'equity';

export type CloseInstruction = {
  ok: true;
  instrument_type: InstrumentType;
  side: 'long' | 'short';
  closeSide: 'buy_to_close' | 'sell_to_close' | 'buy_to_cover' | 'sell';
  closeQty: number;
};

export type CloseInstructionError = {
  ok: false;
  instrument_type: InstrumentType;
  side: 'long' | 'short' | 'unknown';
  quantity: number;
  cost_basis: number;
  error: string;
};

export type TradierPositionLike = {
  symbol?: string;
  quantity?: number;
  cost_basis?: number;
  side?: string;
  instrument_type?: string;
} & Record<string, unknown>;

const isOccOptionSymbol = (s: string) => /^[A-Z]+\d{6}[CP]\d{8}$/.test(s);

function inferSide(pos: TradierPositionLike, qty: number): 'long' | 'short' | 'unknown' {
  const side = String(pos.side || '').toLowerCase();
  if (side === 'long' || side === 'short') return side as 'long' | 'short';
  if (qty < 0) return 'short';
  if (qty > 0) return 'long';
  return 'unknown';
}

function inferSideFromCostBasis(costBasis: number): 'long' | 'short' | 'unknown' {
  if (costBasis < 0) return 'short';
  if (costBasis > 0) return 'long';
  return 'unknown';
}

function detectInstrumentType(pos: TradierPositionLike, positionSymbol: string): InstrumentType {
  const fromPos = String(pos.instrument_type || '').toLowerCase();
  if (fromPos.includes('option')) return 'option';
  if (fromPos.includes('equity') || fromPos.includes('stock')) return 'equity';
  return isOccOptionSymbol(positionSymbol) ? 'option' : 'equity';
}

/**
 * Frontend harness version of the edge-function truth table.
 */
export function getCloseInstruction(
  pos: TradierPositionLike,
  positionSymbol: string,
): CloseInstruction | CloseInstructionError {
  const qty = Number(pos.quantity ?? 0);
  const costBasis = Number(pos.cost_basis ?? 0);
  const instrument_type = detectInstrumentType(pos, positionSymbol);

  let side = inferSide(pos, qty);
  if (side === 'unknown') {
    const cbSide = inferSideFromCostBasis(costBasis);
    if (cbSide !== 'unknown') side = cbSide;
  }

  if (side === 'unknown' || qty === 0) {
    return {
      ok: false,
      instrument_type,
      side,
      quantity: qty,
      cost_basis: costBasis,
      error: `Unable to determine reliable side/size for ${positionSymbol}`,
    };
  }

  if (instrument_type === 'option') {
    return {
      ok: true,
      instrument_type,
      side,
      closeSide: side === 'short' ? 'buy_to_close' : 'sell_to_close',
      closeQty: Math.abs(qty),
    };
  }

  return {
    ok: true,
    instrument_type,
    side,
    closeSide: side === 'short' ? 'buy_to_cover' : 'sell',
    closeQty: Math.abs(qty),
  };
}
