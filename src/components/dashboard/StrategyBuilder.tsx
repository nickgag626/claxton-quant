import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Trash2, Save, RotateCcw, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Strategy, StrategyType, EntryConditions, ExitConditions } from '@/types/trading';

interface StrategyBuilderProps {
  onSaveStrategy: (strategy: Omit<Strategy, 'id'>) => void;
  onClose?: () => void;
}

interface StrategyLeg {
  optionType: 'call' | 'put';
  side: 'buy' | 'sell';
  strikeOffset: number;
  quantity: number;
}

const STRATEGY_PRESETS = {
  '0DTE Iron Condor (SPX)': {
    type: 'iron_condor' as StrategyType,
    underlying: 'SPX',
    dte: 0,
    delta: 0.10,
    wingWidth: 10,
    profitTarget: 50,
    stopLoss: 100,
    legs: [
      { optionType: 'put', side: 'buy', strikeOffset: -10, quantity: 1 },
      { optionType: 'put', side: 'sell', strikeOffset: 0, quantity: 1 },
      { optionType: 'call', side: 'sell', strikeOffset: 0, quantity: 1 },
      { optionType: 'call', side: 'buy', strikeOffset: 10, quantity: 1 },
    ],
  },
  'Weekly Iron Condor (SPY)': {
    type: 'iron_condor' as StrategyType,
    underlying: 'SPY',
    dte: 7,
    delta: 0.16,
    wingWidth: 5,
    profitTarget: 50,
    stopLoss: 200,
    legs: [
      { optionType: 'put', side: 'buy', strikeOffset: -5, quantity: 1 },
      { optionType: 'put', side: 'sell', strikeOffset: 0, quantity: 1 },
      { optionType: 'call', side: 'sell', strikeOffset: 0, quantity: 1 },
      { optionType: 'call', side: 'buy', strikeOffset: 5, quantity: 1 },
    ],
  },
  '30 DTE Credit Put (SPY)': {
    type: 'credit_put_spread' as StrategyType,
    underlying: 'SPY',
    dte: 30,
    delta: 0.30,
    wingWidth: 5,
    profitTarget: 50,
    stopLoss: 200,
    legs: [
      { optionType: 'put', side: 'sell', strikeOffset: 0, quantity: 1 },
      { optionType: 'put', side: 'buy', strikeOffset: -5, quantity: 1 },
    ],
  },
  '0DTE Straddle (SPX)': {
    type: 'straddle' as StrategyType,
    underlying: 'SPX',
    dte: 0,
    delta: 0.50,
    wingWidth: 0,
    profitTarget: 25,
    stopLoss: 100,
    legs: [
      { optionType: 'put', side: 'sell', strikeOffset: 0, quantity: 1 },
      { optionType: 'call', side: 'sell', strikeOffset: 0, quantity: 1 },
    ],
  },
  'Weekly Strangle (SPY)': {
    type: 'strangle' as StrategyType,
    underlying: 'SPY',
    dte: 7,
    delta: 0.16,
    wingWidth: 0,
    profitTarget: 50,
    stopLoss: 200,
    legs: [
      { optionType: 'put', side: 'sell', strikeOffset: 0, quantity: 1 },
      { optionType: 'call', side: 'sell', strikeOffset: 0, quantity: 1 },
    ],
  },
  'Butterfly (SPX)': {
    type: 'butterfly' as StrategyType,
    underlying: 'SPX',
    dte: 7,
    delta: 0.30,
    wingWidth: 10,
    profitTarget: 75,
    stopLoss: 50,
    legs: [
      { optionType: 'call', side: 'buy', strikeOffset: -10, quantity: 1 },
      { optionType: 'call', side: 'sell', strikeOffset: 0, quantity: 2 },
      { optionType: 'call', side: 'buy', strikeOffset: 10, quantity: 1 },
    ],
  },
  'Iron Fly (SPX)': {
    type: 'iron_fly' as StrategyType,
    underlying: 'SPX',
    dte: 0,
    delta: 0.50,
    wingWidth: 20,
    profitTarget: 25,
    stopLoss: 100,
    legs: [
      { optionType: 'put', side: 'buy', strikeOffset: -20, quantity: 1 },
      { optionType: 'put', side: 'sell', strikeOffset: 0, quantity: 1 },
      { optionType: 'call', side: 'sell', strikeOffset: 0, quantity: 1 },
      { optionType: 'call', side: 'buy', strikeOffset: 20, quantity: 1 },
    ],
  },
};

const STRATEGY_TYPES: { value: StrategyType; label: string; description: string }[] = [
  { value: 'iron_condor', label: 'Iron Condor', description: 'Sell OTM Put + Buy further OTM Put + Sell OTM Call + Buy further OTM Call' },
  { value: 'credit_put_spread', label: 'Credit Put Spread', description: 'Sell Put + Buy lower strike Put (bullish)' },
  { value: 'credit_call_spread', label: 'Credit Call Spread', description: 'Sell Call + Buy higher strike Call (bearish)' },
  { value: 'strangle', label: 'Strangle', description: 'Sell OTM Put + Sell OTM Call (neutral, undefined risk)' },
  { value: 'straddle', label: 'Straddle', description: 'Sell ATM Put + Sell ATM Call (neutral, undefined risk)' },
  { value: 'butterfly', label: 'Butterfly', description: 'Buy 1 lower + Sell 2 middle + Buy 1 upper (neutral, defined risk)' },
  { value: 'iron_fly', label: 'Iron Fly', description: 'Sell ATM Put + Sell ATM Call + Buy OTM wings (neutral, defined risk)' },
  { value: 'custom', label: 'Custom', description: 'Define your own leg structure' },
];

const UNDERLYINGS = ['SPX', 'NDX', 'SPY', 'QQQ', 'IWM', 'AAPL', 'TSLA', 'NVDA', 'AMD'];

export const StrategyBuilder = ({ onSaveStrategy, onClose }: StrategyBuilderProps) => {
  // Basic info
  const [name, setName] = useState('');
  const [strategyType, setStrategyType] = useState<StrategyType>('iron_condor');
  const [underlying, setUnderlying] = useState('SPY');
  const [maxPositions, setMaxPositions] = useState(1);
  const [positionSize, setPositionSize] = useState(1);
  
  // Entry conditions
  const [minDte, setMinDte] = useState(0);
  const [maxDte, setMaxDte] = useState(0);
  const [maxDelta, setMaxDelta] = useState(0.10);
  const [wingWidth, setWingWidth] = useState(10);
  const [minPremium, setMinPremium] = useState(0);
  const [useIvFilter, setUseIvFilter] = useState(false);
  const [minIvRank, setMinIvRank] = useState(20);
  const [maxIvRank, setMaxIvRank] = useState(80);
  const [marketHoursOnly, setMarketHoursOnly] = useState(true);
  const [startTime, setStartTime] = useState('09:45');
  const [endTime, setEndTime] = useState('15:30');
  const [is0dte, setIs0dte] = useState(false);
  
  // Exit conditions
  const [profitTarget, setProfitTarget] = useState(50);
  const [stopLoss, setStopLoss] = useState(100);
  const [timeStopDte, setTimeStopDte] = useState(0);
  const [timeStopTime, setTimeStopTime] = useState('15:45');
  const [useTrailingStop, setUseTrailingStop] = useState(false);
  const [trailingStopPercent, setTrailingStopPercent] = useState(25);
  
  // Custom legs
  const [customLegs, setCustomLegs] = useState<StrategyLeg[]>([]);
  const [newLegType, setNewLegType] = useState<'call' | 'put'>('call');
  const [newLegSide, setNewLegSide] = useState<'buy' | 'sell'>('sell');
  const [newLegOffset, setNewLegOffset] = useState(0);
  const [newLegQty, setNewLegQty] = useState(1);

  const loadPreset = (presetName: string) => {
    const preset = STRATEGY_PRESETS[presetName as keyof typeof STRATEGY_PRESETS];
    if (!preset) return;
    
    setName(presetName);
    setStrategyType(preset.type);
    setUnderlying(preset.underlying);
    setMinDte(preset.dte);
    setMaxDte(preset.dte);
    setMaxDelta(preset.delta);
    setWingWidth(preset.wingWidth);
    setProfitTarget(preset.profitTarget);
    setStopLoss(preset.stopLoss);
    setCustomLegs(preset.legs as StrategyLeg[]);
    setIs0dte(preset.dte === 0);
  };

  const addCustomLeg = () => {
    setCustomLegs([...customLegs, {
      optionType: newLegType,
      side: newLegSide,
      strikeOffset: newLegOffset,
      quantity: newLegQty,
    }]);
  };

  const removeLeg = (index: number) => {
    setCustomLegs(customLegs.filter((_, i) => i !== index));
  };

  const buildLegsFromType = (): StrategyLeg[] => {
    if (strategyType === 'custom') return customLegs;
    
    switch (strategyType) {
      case 'iron_condor':
        return [
          { optionType: 'put', side: 'buy', strikeOffset: -wingWidth, quantity: 1 },
          { optionType: 'put', side: 'sell', strikeOffset: 0, quantity: 1 },
          { optionType: 'call', side: 'sell', strikeOffset: 0, quantity: 1 },
          { optionType: 'call', side: 'buy', strikeOffset: wingWidth, quantity: 1 },
        ];
      case 'credit_put_spread':
        return [
          { optionType: 'put', side: 'sell', strikeOffset: 0, quantity: 1 },
          { optionType: 'put', side: 'buy', strikeOffset: -wingWidth, quantity: 1 },
        ];
      case 'credit_call_spread':
        return [
          { optionType: 'call', side: 'sell', strikeOffset: 0, quantity: 1 },
          { optionType: 'call', side: 'buy', strikeOffset: wingWidth, quantity: 1 },
        ];
      case 'strangle':
      case 'straddle':
        return [
          { optionType: 'put', side: 'sell', strikeOffset: 0, quantity: 1 },
          { optionType: 'call', side: 'sell', strikeOffset: 0, quantity: 1 },
        ];
      case 'butterfly':
        return [
          { optionType: 'call', side: 'buy', strikeOffset: -wingWidth, quantity: 1 },
          { optionType: 'call', side: 'sell', strikeOffset: 0, quantity: 2 },
          { optionType: 'call', side: 'buy', strikeOffset: wingWidth, quantity: 1 },
        ];
      case 'iron_fly':
        return [
          { optionType: 'put', side: 'buy', strikeOffset: -wingWidth, quantity: 1 },
          { optionType: 'put', side: 'sell', strikeOffset: 0, quantity: 1 },
          { optionType: 'call', side: 'sell', strikeOffset: 0, quantity: 1 },
          { optionType: 'call', side: 'buy', strikeOffset: wingWidth, quantity: 1 },
        ];
      default:
        return [];
    }
  };

  const handleSave = () => {
    const entryConditions: EntryConditions = {
      minDte,
      maxDte,
      maxDelta,
      minPremium: minPremium > 0 ? minPremium : undefined,
      minIvRank: useIvFilter ? minIvRank : undefined,
      maxIvRank: useIvFilter ? maxIvRank : undefined,
      marketHoursOnly,
      startTime: marketHoursOnly ? startTime : undefined,
      endTime: marketHoursOnly ? endTime : undefined,
    };

    const exitConditions: ExitConditions = {
      profitTargetPercent: profitTarget,
      stopLossPercent: stopLoss,
      timeStopDte,
      timeStopTime: is0dte ? timeStopTime : undefined,
      trailingStopPercent: useTrailingStop ? trailingStopPercent : undefined,
    };

    const strategy: Omit<Strategy, 'id'> = {
      name: name || `${strategyType} - ${underlying}`,
      type: strategyType,
      underlying,
      enabled: true,
      maxPositions,
      positionSize,
      entryConditions,
      exitConditions,
    };

    onSaveStrategy(strategy);
  };

  const strategyInfo = STRATEGY_TYPES.find(t => t.value === strategyType);
  const currentLegs = strategyType === 'custom' ? customLegs : buildLegsFromType();

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="terminal-panel"
    >
      <div className="flex items-center justify-between border-b border-border pb-3 mb-4">
        <div>
          <h3 className="text-lg font-semibold text-foreground">Strategy Factory</h3>
          <p className="text-xs text-muted-foreground">Build custom strategies by selecting a template and adjusting parameters</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>×</Button>
      </div>

      <Tabs defaultValue="quick" className="space-y-4">
        <TabsList className="grid w-full grid-cols-3 bg-secondary/50">
          <TabsTrigger value="quick" className="text-xs data-[state=active]:bg-bloomberg-amber data-[state=active]:text-black">
            Quick Build
          </TabsTrigger>
          <TabsTrigger value="advanced" className="text-xs data-[state=active]:bg-bloomberg-amber data-[state=active]:text-black">
            Advanced Builder
          </TabsTrigger>
          <TabsTrigger value="presets" className="text-xs data-[state=active]:bg-bloomberg-amber data-[state=active]:text-black">
            Load Preset
          </TabsTrigger>
        </TabsList>

        {/* PRESETS TAB */}
        <TabsContent value="presets" className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {Object.keys(STRATEGY_PRESETS).map((presetName) => (
              <Button
                key={presetName}
                variant="secondary"
                size="sm"
                onClick={() => loadPreset(presetName)}
                className="text-xs h-auto py-2 px-3 justify-start"
              >
                <Zap className="w-3 h-3 mr-1.5 text-bloomberg-amber" />
                {presetName}
              </Button>
            ))}
          </div>
        </TabsContent>

        {/* QUICK BUILD TAB */}
        <TabsContent value="quick" className="space-y-4">
          {/* Step 1: Strategy Structure */}
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Step 1: Choose Strategy Structure</h4>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Strategy Type</Label>
                <Select value={strategyType} onValueChange={(v) => setStrategyType(v as StrategyType)}>
                  <SelectTrigger className="bg-secondary/50 border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STRATEGY_TYPES.map((type) => (
                      <SelectItem key={type.value} value={type.value}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {strategyInfo && (
                  <p className="text-[10px] text-muted-foreground">{strategyInfo.description}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Underlying Symbol</Label>
                <Select value={underlying} onValueChange={setUnderlying}>
                  <SelectTrigger className="bg-secondary/50 border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {UNDERLYINGS.map((sym) => (
                      <SelectItem key={sym} value={sym}>{sym}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Strategy Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={`${strategyType} - ${underlying}`}
                  className="bg-secondary/50 border-border text-sm"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Max Positions</Label>
                <Input
                  type="number"
                  value={maxPositions}
                  onChange={(e) => setMaxPositions(parseInt(e.target.value) || 1)}
                  min={1}
                  max={10}
                  className="bg-secondary/50 border-border text-sm"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Contracts/Position</Label>
                <Input
                  type="number"
                  value={positionSize}
                  onChange={(e) => setPositionSize(parseInt(e.target.value) || 1)}
                  min={1}
                  max={100}
                  className="bg-secondary/50 border-border text-sm"
                />
              </div>
            </div>
          </div>

          {/* Step 2: Entry Conditions */}
          <div className="space-y-3 pt-4 border-t border-border">
            <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Step 2: Entry Conditions</h4>
            
            <div className="grid grid-cols-3 gap-4">
              {/* Timing */}
              <div className="space-y-3">
                <Label className="text-xs text-bloomberg-amber font-medium">Timing</Label>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={is0dte}
                    onCheckedChange={(checked) => {
                      setIs0dte(checked);
                      if (checked) {
                        setMinDte(0);
                        setMaxDte(0);
                      }
                    }}
                  />
                  <Label className="text-xs">0DTE Trade</Label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">Min DTE</Label>
                    <Input
                      type="number"
                      value={minDte}
                      onChange={(e) => setMinDte(parseInt(e.target.value) || 0)}
                      min={0}
                      max={90}
                      disabled={is0dte}
                      className="bg-secondary/50 border-border text-xs h-8"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">Max DTE</Label>
                    <Input
                      type="number"
                      value={maxDte}
                      onChange={(e) => setMaxDte(parseInt(e.target.value) || 0)}
                      min={0}
                      max={90}
                      disabled={is0dte}
                      className="bg-secondary/50 border-border text-xs h-8"
                    />
                  </div>
                </div>
              </div>

              {/* Strike Selection */}
              <div className="space-y-3">
                <Label className="text-xs text-bloomberg-amber font-medium">Strike Selection</Label>
                <div className="space-y-2">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-muted-foreground">Short Strike Delta</span>
                    <span className="font-mono text-foreground">{maxDelta.toFixed(2)}</span>
                  </div>
                  <Slider
                    value={[maxDelta * 100]}
                    onValueChange={([v]) => setMaxDelta(v / 100)}
                    min={5}
                    max={50}
                    step={1}
                    className="w-full"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Wing Width (points)</Label>
                  <Input
                    type="number"
                    value={wingWidth}
                    onChange={(e) => setWingWidth(parseInt(e.target.value) || 0)}
                    min={0}
                    max={100}
                    className="bg-secondary/50 border-border text-xs h-8"
                  />
                </div>
              </div>

              {/* IV & Premium */}
              <div className="space-y-3">
                <Label className="text-xs text-bloomberg-amber font-medium">IV & Premium</Label>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={useIvFilter}
                    onCheckedChange={setUseIvFilter}
                  />
                  <Label className="text-xs">Filter by IV Rank</Label>
                </div>
                {useIvFilter && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Min IV</Label>
                      <Input
                        type="number"
                        value={minIvRank}
                        onChange={(e) => setMinIvRank(parseInt(e.target.value) || 0)}
                        min={0}
                        max={100}
                        className="bg-secondary/50 border-border text-xs h-8"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Max IV</Label>
                      <Input
                        type="number"
                        value={maxIvRank}
                        onChange={(e) => setMaxIvRank(parseInt(e.target.value) || 0)}
                        min={0}
                        max={100}
                        className="bg-secondary/50 border-border text-xs h-8"
                      />
                    </div>
                  </div>
                )}
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Min Premium ($)</Label>
                  <Input
                    type="number"
                    value={minPremium}
                    onChange={(e) => setMinPremium(parseFloat(e.target.value) || 0)}
                    min={0}
                    step={0.25}
                    className="bg-secondary/50 border-border text-xs h-8"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Step 3: Exit Conditions */}
          <div className="space-y-3 pt-4 border-t border-border">
            <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Step 3: Exit Conditions</h4>
            
            <div className="grid grid-cols-3 gap-4">
              {/* Profit & Loss */}
              <div className="space-y-3">
                <Label className="text-xs text-bloomberg-amber font-medium">Profit & Loss</Label>
                <div className="space-y-2">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-muted-foreground">Profit Target</span>
                    <span className="font-mono text-trading-green">{profitTarget}%</span>
                  </div>
                  <Slider
                    value={[profitTarget]}
                    onValueChange={([v]) => setProfitTarget(v)}
                    min={10}
                    max={100}
                    step={5}
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-muted-foreground">Stop Loss</span>
                    <span className="font-mono text-panic-red">{stopLoss}%</span>
                  </div>
                  <Slider
                    value={[stopLoss]}
                    onValueChange={([v]) => setStopLoss(v)}
                    min={25}
                    max={500}
                    step={25}
                  />
                </div>
              </div>

              {/* Time Stops */}
              <div className="space-y-3">
                <Label className="text-xs text-bloomberg-amber font-medium">Time Stops</Label>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Close at DTE</Label>
                  <Input
                    type="number"
                    value={timeStopDte}
                    onChange={(e) => setTimeStopDte(parseInt(e.target.value) || 0)}
                    min={0}
                    max={30}
                    className="bg-secondary/50 border-border text-xs h-8"
                  />
                </div>
                {is0dte && (
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">Time Stop (expiry day)</Label>
                    <Input
                      type="time"
                      value={timeStopTime}
                      onChange={(e) => setTimeStopTime(e.target.value)}
                      className="bg-secondary/50 border-border text-xs h-8"
                    />
                  </div>
                )}
              </div>

              {/* Advanced Exits */}
              <div className="space-y-3">
                <Label className="text-xs text-bloomberg-amber font-medium">Advanced Exits</Label>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={useTrailingStop}
                    onCheckedChange={setUseTrailingStop}
                  />
                  <Label className="text-xs">Use Trailing Stop</Label>
                </div>
                {useTrailingStop && (
                  <div className="space-y-2">
                    <div className="flex justify-between text-[10px]">
                      <span className="text-muted-foreground">Trailing Stop</span>
                      <span className="font-mono">{trailingStopPercent}%</span>
                    </div>
                    <Slider
                      value={[trailingStopPercent]}
                      onValueChange={([v]) => setTrailingStopPercent(v)}
                      min={10}
                      max={50}
                      step={5}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Leg Preview */}
          <div className="pt-4 border-t border-border">
            <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Strategy Legs Preview</h4>
            <div className="flex flex-wrap gap-2">
              {currentLegs.map((leg, i) => (
                <Badge
                  key={i}
                  variant="secondary"
                  className={cn(
                    "font-mono text-xs",
                    leg.side === 'sell' 
                      ? 'bg-panic-red/20 text-panic-red border-panic-red/30' 
                      : 'bg-trading-green/20 text-trading-green border-trading-green/30'
                  )}
                >
                  {leg.side === 'sell' ? '🔴' : '🟢'} {leg.side.toUpperCase()} {leg.quantity}x {leg.optionType.toUpperCase()} @ ATM{leg.strikeOffset >= 0 ? '+' : ''}{leg.strikeOffset}
                </Badge>
              ))}
            </div>
          </div>

          {/* Save Button */}
          <div className="pt-4 border-t border-border">
            <Button 
              onClick={handleSave} 
              className="w-full bg-trading-green hover:bg-trading-green/90 text-black font-semibold"
            >
              <Save className="w-4 h-4 mr-2" />
              Create Strategy
            </Button>
          </div>
        </TabsContent>

        {/* ADVANCED BUILDER TAB */}
        <TabsContent value="advanced" className="space-y-4">
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Custom Leg Builder</h4>
            <p className="text-xs text-muted-foreground">Define each leg of your strategy manually</p>
            
            <div className="grid grid-cols-4 gap-2">
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Option Type</Label>
                <Select value={newLegType} onValueChange={(v) => setNewLegType(v as 'call' | 'put')}>
                  <SelectTrigger className="bg-secondary/50 border-border text-xs h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="call">Call</SelectItem>
                    <SelectItem value="put">Put</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Side</Label>
                <Select value={newLegSide} onValueChange={(v) => setNewLegSide(v as 'buy' | 'sell')}>
                  <SelectTrigger className="bg-secondary/50 border-border text-xs h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="buy">Buy</SelectItem>
                    <SelectItem value="sell">Sell</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Strike Offset</Label>
                <Input
                  type="number"
                  value={newLegOffset}
                  onChange={(e) => setNewLegOffset(parseInt(e.target.value) || 0)}
                  className="bg-secondary/50 border-border text-xs h-8"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Qty</Label>
                <Input
                  type="number"
                  value={newLegQty}
                  onChange={(e) => setNewLegQty(parseInt(e.target.value) || 1)}
                  min={1}
                  max={10}
                  className="bg-secondary/50 border-border text-xs h-8"
                />
              </div>
            </div>
            
            <Button onClick={addCustomLeg} variant="secondary" size="sm">
              <Plus className="w-3 h-3 mr-1" />
              Add Leg
            </Button>
          </div>

          {/* Custom Legs List */}
          {customLegs.length > 0 && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Current Legs:</Label>
              <AnimatePresence>
                {customLegs.map((leg, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    className="flex items-center justify-between p-2 bg-secondary/30 rounded"
                  >
                    <span className="font-mono text-xs">
                      {leg.side === 'sell' ? '🔴' : '🟢'} {leg.side.toUpperCase()} {leg.quantity}x {leg.optionType.toUpperCase()} @ ATM{leg.strikeOffset >= 0 ? '+' : ''}{leg.strikeOffset}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => removeLeg(i)}>
                      <Trash2 className="w-3 h-3 text-panic-red" />
                    </Button>
                  </motion.div>
                ))}
              </AnimatePresence>
              
              <Button variant="secondary" size="sm" onClick={() => setCustomLegs([])}>
                <RotateCcw className="w-3 h-3 mr-1" />
                Clear All
              </Button>
            </div>
          )}

          {customLegs.length > 0 && (
            <div className="pt-4 border-t border-border space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Strategy Name</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Custom Strategy"
                    className="bg-secondary/50 border-border text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Underlying</Label>
                  <Select value={underlying} onValueChange={setUnderlying}>
                    <SelectTrigger className="bg-secondary/50 border-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {UNDERLYINGS.map((sym) => (
                        <SelectItem key={sym} value={sym}>{sym}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              
              <Button 
                onClick={() => {
                  setStrategyType('custom');
                  handleSave();
                }} 
                className="w-full bg-trading-green hover:bg-trading-green/90 text-black font-semibold"
              >
                <Save className="w-4 h-4 mr-2" />
                Create Custom Strategy
              </Button>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </motion.div>
  );
};
