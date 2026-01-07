import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Loader2, TrendingUp, TrendingDown } from 'lucide-react';
import { tradierApi } from '@/services/tradierApi';

interface OptionContract {
  symbol: string;
  strike: number;
  bid: number;
  ask: number;
  last: number | null;
  volume: number;
  open_interest: number;
  option_type: 'call' | 'put';
  greeks?: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
  };
}

const UNDERLYING_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'DIA', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'META'];

export const OptionsChain = () => {
  const [underlying, setUnderlying] = useState('SPY');
  const [expirations, setExpirations] = useState<string[]>([]);
  const [selectedExpiration, setSelectedExpiration] = useState<string>('');
  const [chain, setChain] = useState<OptionContract[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingExpirations, setLoadingExpirations] = useState(false);
  const [underlyingPrice, setUnderlyingPrice] = useState<number | null>(null);

  // Fetch expirations when underlying changes
  useEffect(() => {
    const fetchExpirations = async () => {
      setLoadingExpirations(true);
      try {
        const exps = await tradierApi.getOptionExpirations(underlying);
        setExpirations(exps);
        if (exps.length > 0) {
          setSelectedExpiration(exps[0]);
        }
      } catch (error) {
        console.error('Failed to fetch expirations:', error);
        setExpirations([]);
      } finally {
        setLoadingExpirations(false);
      }
    };

    // Also fetch the underlying quote
    const fetchQuote = async () => {
      try {
        const quotes = await tradierApi.getQuotes([underlying]);
        if (quotes[underlying]) {
          setUnderlyingPrice(quotes[underlying].last);
        }
      } catch (error) {
        console.error('Failed to fetch quote:', error);
      }
    };

    fetchExpirations();
    fetchQuote();
  }, [underlying]);

  // Fetch chain when expiration changes
  useEffect(() => {
    if (!selectedExpiration) return;

    const fetchChain = async () => {
      setLoading(true);
      try {
        const chainData = await tradierApi.getOptionChain(underlying, selectedExpiration);
        setChain(chainData);
      } catch (error) {
        console.error('Failed to fetch chain:', error);
        setChain([]);
      } finally {
        setLoading(false);
      }
    };

    fetchChain();
  }, [underlying, selectedExpiration]);

  const calls = chain.filter(c => c.option_type === 'call').sort((a, b) => a.strike - b.strike);
  const puts = chain.filter(c => c.option_type === 'put').sort((a, b) => a.strike - b.strike);

  // Combine calls and puts by strike
  const strikes = [...new Set(chain.map(c => c.strike))].sort((a, b) => a - b);
  
  const getContractByStrike = (strike: number, type: 'call' | 'put') => {
    return chain.find(c => c.strike === strike && c.option_type === type);
  };

  const formatNumber = (num: number | null | undefined, decimals = 2) => {
    if (num === null || num === undefined) return '-';
    return num.toFixed(decimals);
  };

  const formatDelta = (delta: number | undefined) => {
    if (delta === undefined) return '-';
    return (delta * 100).toFixed(0);
  };

  const isAtTheMoney = (strike: number) => {
    if (!underlyingPrice) return false;
    return Math.abs(strike - underlyingPrice) < 1;
  };

  const isInTheMoney = (strike: number, type: 'call' | 'put') => {
    if (!underlyingPrice) return false;
    if (type === 'call') return strike < underlyingPrice;
    return strike > underlyingPrice;
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <CardTitle className="text-lg font-semibold text-foreground">
            Options Chain
            {underlyingPrice && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {underlying} @ ${underlyingPrice.toFixed(2)}
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Select value={underlying} onValueChange={setUnderlying}>
              <SelectTrigger className="w-[100px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNDERLYING_SYMBOLS.map(sym => (
                  <SelectItem key={sym} value={sym}>{sym}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select 
              value={selectedExpiration} 
              onValueChange={setSelectedExpiration}
              disabled={loadingExpirations || expirations.length === 0}
            >
              <SelectTrigger className="w-[140px]">
                {loadingExpirations ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <SelectValue placeholder="Expiration" />
                )}
              </SelectTrigger>
              <SelectContent>
                {expirations.map(exp => (
                  <SelectItem key={exp} value={exp}>{exp}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : chain.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            No options data available
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border">
                  <TableHead colSpan={5} className="text-center bg-success/10 text-success">
                    <div className="flex items-center justify-center gap-1">
                      <TrendingUp className="h-4 w-4" />
                      CALLS
                    </div>
                  </TableHead>
                  <TableHead className="text-center bg-muted font-bold">Strike</TableHead>
                  <TableHead colSpan={5} className="text-center bg-destructive/10 text-destructive">
                    <div className="flex items-center justify-center gap-1">
                      <TrendingDown className="h-4 w-4" />
                      PUTS
                    </div>
                  </TableHead>
                </TableRow>
                <TableRow className="border-border text-xs">
                  <TableHead className="text-right">Bid</TableHead>
                  <TableHead className="text-right">Ask</TableHead>
                  <TableHead className="text-right">Last</TableHead>
                  <TableHead className="text-right">Vol</TableHead>
                  <TableHead className="text-right">Δ</TableHead>
                  <TableHead className="text-center font-bold">Strike</TableHead>
                  <TableHead className="text-right">Δ</TableHead>
                  <TableHead className="text-right">Bid</TableHead>
                  <TableHead className="text-right">Ask</TableHead>
                  <TableHead className="text-right">Last</TableHead>
                  <TableHead className="text-right">Vol</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {strikes.map(strike => {
                  const call = getContractByStrike(strike, 'call');
                  const put = getContractByStrike(strike, 'put');
                  const atm = isAtTheMoney(strike);
                  const callItm = isInTheMoney(strike, 'call');
                  const putItm = isInTheMoney(strike, 'put');

                  return (
                    <TableRow 
                      key={strike} 
                      className={`border-border text-xs ${atm ? 'bg-primary/10' : ''}`}
                    >
                      {/* CALLS */}
                      <TableCell className={`text-right ${callItm ? 'bg-success/5' : ''}`}>
                        {formatNumber(call?.bid)}
                      </TableCell>
                      <TableCell className={`text-right ${callItm ? 'bg-success/5' : ''}`}>
                        {formatNumber(call?.ask)}
                      </TableCell>
                      <TableCell className={`text-right ${callItm ? 'bg-success/5' : ''}`}>
                        {formatNumber(call?.last)}
                      </TableCell>
                      <TableCell className={`text-right ${callItm ? 'bg-success/5' : ''}`}>
                        {call?.volume || '-'}
                      </TableCell>
                      <TableCell className={`text-right ${callItm ? 'bg-success/5' : ''}`}>
                        {formatDelta(call?.greeks?.delta)}
                      </TableCell>
                      
                      {/* STRIKE */}
                      <TableCell className="text-center font-bold bg-muted">
                        {atm ? (
                          <Badge variant="outline" className="bg-primary text-primary-foreground">
                            {strike.toFixed(0)}
                          </Badge>
                        ) : (
                          strike.toFixed(0)
                        )}
                      </TableCell>
                      
                      {/* PUTS */}
                      <TableCell className={`text-right ${putItm ? 'bg-destructive/5' : ''}`}>
                        {formatDelta(put?.greeks?.delta)}
                      </TableCell>
                      <TableCell className={`text-right ${putItm ? 'bg-destructive/5' : ''}`}>
                        {formatNumber(put?.bid)}
                      </TableCell>
                      <TableCell className={`text-right ${putItm ? 'bg-destructive/5' : ''}`}>
                        {formatNumber(put?.ask)}
                      </TableCell>
                      <TableCell className={`text-right ${putItm ? 'bg-destructive/5' : ''}`}>
                        {formatNumber(put?.last)}
                      </TableCell>
                      <TableCell className={`text-right ${putItm ? 'bg-destructive/5' : ''}`}>
                        {put?.volume || '-'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
