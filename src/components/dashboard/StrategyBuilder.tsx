import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Trash2, Save, RotateCcw, Zap, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { 
  Strategy, 
  StrategyType, 
  EntryConditions, 
  ExitConditions, 
  TrackedLeg, 
  TrackedLegRole,
  StrategySizing,
  MAFilter,
  MAFilterRule,
  TrailingStopConfig 
} from '@/types/trading';

interface StrategyBuilderProps {
  onSaveStrategy: (strategy: Omit<Strategy, 'id'>) => void;
  onClose?: () => void;
  editingStrategy?: Strategy;
}

interface StrategyLeg {
  optionType: 'call' | 'put';
  side: 'buy' | 'sell';
  strikeOffset: number;
  quantity: number;
}

// Updated presets with new delta fields
// SAFETY: Only defined-risk strategies included. Straddles/strangles removed (unlimited loss).
const STRATEGY_PRESETS = {
  '0DTE Iron Condor (SPX)': {
    type: 'iron_condor' as StrategyType,
    underlying: 'SPX',
    dte: 0,
    shortDeltaTarget: 0.10,
    longDeltaTarget: 0.05,
    wingWidth: 10,
    minPremium: 1.50, // REQUIRED: Prevents tiny credits that cause random exits
    profitTarget: 50,
    stopLoss: 100,
    sizing: { mode: 'fixed' as const, fixedContracts: 1 },
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
    shortDeltaTarget: 0.16,
    longDeltaTarget: 0.08,
    wingWidth: 5,
    minPremium: 0.75, // REQUIRED: Prevents tiny credits that cause random exits
    profitTarget: 50,
    stopLoss: 200,
    sizing: { mode: 'fixed' as const, fixedContracts: 1 },
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
    shortDeltaTarget: 0.30,
    longDeltaTarget: 0.15,
    wingWidth: 5,
    minPremium: 1.00, // REQUIRED: Prevents tiny credits that cause random exits
    profitTarget: 50,
    stopLoss: 200,
    sizing: { mode: 'fixed' as const, fixedContracts: 1 },
    legs: [
      { optionType: 'put', side: 'sell', strikeOffset: 0, quantity: 1 },
      { optionType: 'put', side: 'buy', strikeOffset: -5, quantity: 1 },
    ],
  },
  // REMOVED: '0DTE Straddle (SPX)' - UNDEFINED RISK (unlimited loss potential)
  // REMOVED: 'Weekly Strangle (SPY)' - UNDEFINED RISK (unlimited loss potential)
  'Butterfly (SPX)': {
    type: 'butterfly' as StrategyType,
    underlying: 'SPX',
    dte: 7,
    shortDeltaTarget: 0.30,
    longDeltaTarget: 0.15,
    wingWidth: 10,
    minPremium: 0.50, // REQUIRED: Prevents tiny credits that cause random exits
    profitTarget: 75,
    stopLoss: 50,
    sizing: { mode: 'fixed' as const, fixedContracts: 1 },
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
    shortDeltaTarget: 0.50,
    longDeltaTarget: 0.10,
    wingWidth: 20,
    minPremium: 3.00, // REQUIRED: Iron flies have higher premiums
    profitTarget: 25,
    stopLoss: 100,
    sizing: { mode: 'fixed' as const, fixedContracts: 1 },
    legs: [
      { optionType: 'put', side: 'buy', strikeOffset: -20, quantity: 1 },
      { optionType: 'put', side: 'sell', strikeOffset: 0, quantity: 1 },
      { optionType: 'call', side: 'sell', strikeOffset: 0, quantity: 1 },
      { optionType: 'call', side: 'buy', strikeOffset: 20, quantity: 1 },
    ],
  },
};

const STRATEGY_TYPES: { value: StrategyType; label: string; description: string; risk?: 'defined' | 'undefined' }[] = [
  { value: 'iron_condor', label: 'Iron Condor', description: 'Sell OTM Put + Buy further OTM Put + Sell OTM Call + Buy further OTM Call', risk: 'defined' },
  { value: 'credit_put_spread', label: 'Credit Put Spread', description: 'Sell Put + Buy lower strike Put (bullish)', risk: 'defined' },
  { value: 'credit_call_spread', label: 'Credit Call Spread', description: 'Sell Call + Buy higher strike Call (bearish)', risk: 'defined' },
  { value: 'strangle', label: 'Strangle (DISABLED)', description: 'UNLIMITED LOSS - Not available for automated trading', risk: 'undefined' },
  { value: 'straddle', label: 'Straddle (DISABLED)', description: 'UNLIMITED LOSS - Not available for automated trading', risk: 'undefined' },
  { value: 'butterfly', label: 'Butterfly', description: 'Buy 1 lower + Sell 2 middle + Buy 1 upper (neutral, defined risk)', risk: 'defined' },
  { value: 'iron_fly', label: 'Iron Fly', description: 'Sell ATM Put + Sell ATM Call + Buy OTM wings (neutral, defined risk)', risk: 'defined' },
  { value: 'custom', label: 'Custom', description: 'Define your own leg structure' },
];

const UNDERLYINGS = ['SPX', 'NDX', 'SPY', 'QQQ', 'IWM', 'AAPL', 'TSLA', 'NVDA', 'AMD'];

// Default minPremium values by strategy type (prevents tiny credits causing random exits)
const MIN_PREMIUM_DEFAULTS: Record<StrategyType, number> = {
  iron_condor: 1.00,
  iron_fly: 3.00,
  credit_put_spread: 0.75,
  credit_call_spread: 0.75,
  butterfly: 0.50,
  strangle: 1.00,  // (disabled - undefined risk)
  straddle: 1.00,  // (disabled - undefined risk)
  custom: 0.50,
};

// MA filter preset rules
const MA_PRESETS: { label: string; rules: MAFilterRule[] }[] = [
  { label: 'Price above SMA20', rules: [{ left: 'price', op: 'above', right: 'sma20' }] },
  { label: 'Price above SMA50', rules: [{ left: 'price', op: 'above', right: 'sma50' }] },
  { label: 'SMA50 above SMA200', rules: [{ left: 'sma50', op: 'above', right: 'sma200' }] },
  { label: 'Price above SMA50 and SMA50 above SMA200', rules: [
    { left: 'price', op: 'above', right: 'sma50' },
    { left: 'sma50', op: 'above', right: 'sma200' }
  ]},
];

// Get default tracked legs based on strategy type
function getDefaultTrackedLegs(type: StrategyType): TrackedLeg[] {
  switch (type) {
    case 'iron_condor':
    case 'iron_fly':
      return [
        { role: 'short_put', optionType: 'put', side: 'sell', closeOnExit: true },
        { role: 'long_put', optionType: 'put', side: 'buy', closeOnExit: true },
        { role: 'short_call', optionType: 'call', side: 'sell', closeOnExit: true },
        { role: 'long_call', optionType: 'call', side: 'buy', closeOnExit: true },
      ];
    case 'credit_put_spread':
      return [
        { role: 'short_put', optionType: 'put', side: 'sell', closeOnExit: true },
        { role: 'long_put', optionType: 'put', side: 'buy', closeOnExit: true },
      ];
    case 'credit_call_spread':
      return [
        { role: 'short_call', optionType: 'call', side: 'sell', closeOnExit: true },
        { role: 'long_call', optionType: 'call', side: 'buy', closeOnExit: true },
      ];
    case 'strangle':
    case 'straddle':
      return [
        { role: 'short_put', optionType: 'put', side: 'sell', closeOnExit: true },
        { role: 'short_call', optionType: 'call', side: 'sell', closeOnExit: true },
      ];
    case 'butterfly':
      return [
        { role: 'long_call', optionType: 'call', side: 'buy', closeOnExit: true },
        { role: 'short_call', optionType: 'call', side: 'sell', closeOnExit: true },
        { role: 'long_call', optionType: 'call', side: 'buy', closeOnExit: true },
      ];
    default:
      return [];
  }
}

// Check if strategy type supports long delta (has wing/protective legs)
function supportsLongDelta(type: StrategyType): boolean {
  return ['iron_condor', 'iron_fly', 'credit_put_spread', 'credit_call_spread', 'butterfly'].includes(type);
}

export const StrategyBuilder = ({ onSaveStrategy, onClose, editingStrategy }: StrategyBuilderProps) => {
  const isEditing = !!editingStrategy;
  
  // Basic info
  const [name, setName] = useState('');
  const [strategyType, setStrategyType] = useState<StrategyType>('iron_condor');
  const [underlying, setUnderlying] = useState('SPY');
  const [maxPositions, setMaxPositions] = useState(1);
  const [positionSize, setPositionSize] = useState(1);
  
  // Entry conditions
  const [minDte, setMinDte] = useState(0);
  const [maxDte, setMaxDte] = useState(0);
  const [shortDeltaTarget, setShortDeltaTarget] = useState(0.10);
  const [longDeltaTarget, setLongDeltaTarget] = useState(0.05);
  const [wingWidth, setWingWidth] = useState(10);
  const [minPremium, setMinPremium] = useState(MIN_PREMIUM_DEFAULTS['iron_condor']);
  const [useIvFilter, setUseIvFilter] = useState(false);
  const [minIvRank, setMinIvRank] = useState(20);
  const [maxIvRank, setMaxIvRank] = useState(80);
  const [marketHoursOnly, setMarketHoursOnly] = useState(true);
  const [startTime, setStartTime] = useState('09:45');
  const [endTime, setEndTime] = useState('15:30');
  const [is0dte, setIs0dte] = useState(false);
  
  // MA Filter
  const [useMaFilter, setUseMaFilter] = useState(false);
  const [maFilterPreset, setMaFilterPreset] = useState<string>('');
  const [maFilter, setMaFilter] = useState<MAFilter>({
    enabled: false,
    sma20: false,
    sma50: false,
    sma200: false,
    rules: [],
  });
  
  // Exit conditions
  const [profitTarget, setProfitTarget] = useState(50);
  const [stopLoss, setStopLoss] = useState(100);
  const [timeStopDte, setTimeStopDte] = useState(0);
  const [timeStopTime, setTimeStopTime] = useState('15:45');
  
  // Advanced trailing stop
  const [useTrailingStop, setUseTrailingStop] = useState(false);
  const [trailingStopType, setTrailingStopType] = useState<'percent' | 'dollars'>('percent');
  const [trailingStopAmount, setTrailingStopAmount] = useState(25);
  const [trailingStopActivation, setTrailingStopActivation] = useState<number | undefined>(undefined);
  const [trailingStopBasis, setTrailingStopBasis] = useState<'group' | 'tracked_legs' | 'short_legs'>('group');
  
  // Tracked legs
  const [trackedLegs, setTrackedLegs] = useState<TrackedLeg[]>([]);
  
  // Sizing
  const [sizingMode, setSizingMode] = useState<'fixed' | 'risk'>('fixed');
  const [riskPerTrade, setRiskPerTrade] = useState(100);
  const [maxContracts, setMaxContracts] = useState(10);
  
  // Custom legs
  const [customLegs, setCustomLegs] = useState<StrategyLeg[]>([]);
  const [newLegType, setNewLegType] = useState<'call' | 'put'>('call');
  const [newLegSide, setNewLegSide] = useState<'buy' | 'sell'>('sell');
  const [newLegOffset, setNewLegOffset] = useState(0);
  const [newLegQty, setNewLegQty] = useState(1);
  
  // Populate form when editing
  useEffect(() => {
    if (!editingStrategy) return;
    
    const s = editingStrategy;
    const entry = s.entryConditions;
    const exit = s.exitConditions;
    const sizing = s.sizing;
    
    setName(s.name);
    setStrategyType(s.type);
    setUnderlying(s.underlying);
    setMaxPositions(s.maxPositions);
    setPositionSize(s.positionSize);
    
    // Entry conditions
    setMinDte(entry.minDte);
    setMaxDte(entry.maxDte);
    setIs0dte(entry.minDte === 0 && entry.maxDte === 0);
    setShortDeltaTarget(entry.shortDeltaTarget ?? entry.maxDelta ?? 0.10);
    setLongDeltaTarget(entry.longDeltaTarget ?? 0.05);
    setMinPremium(entry.minPremium ?? 0);
    setUseIvFilter(!!(entry.minIvRank || entry.maxIvRank));
    setMinIvRank(entry.minIvRank ?? 20);
    setMaxIvRank(entry.maxIvRank ?? 80);
    setMarketHoursOnly(entry.marketHoursOnly ?? true);
    setStartTime(entry.startTime ?? '09:45');
    setEndTime(entry.endTime ?? '15:30');
    
    // MA Filter
    if (entry.maFilter?.enabled) {
      setUseMaFilter(true);
      setMaFilter(entry.maFilter);
    }
    
    // Exit conditions
    setProfitTarget(exit.profitTargetPercent);
    setStopLoss(exit.stopLossPercent);
    setTimeStopDte(exit.timeStopDte ?? 0);
    setTimeStopTime(exit.timeStopTime ?? '15:45');
    
    // Trailing stop
    if (exit.trailingStop?.enabled) {
      setUseTrailingStop(true);
      setTrailingStopType(exit.trailingStop.type);
      setTrailingStopAmount(exit.trailingStop.amount);
      setTrailingStopActivation(exit.trailingStop.activationProfit);
      setTrailingStopBasis(exit.trailingStop.basis ?? 'group');
    }
    
    // Sizing
    if (sizing) {
      setSizingMode(sizing.mode);
      if (sizing.mode === 'risk') {
        setRiskPerTrade(sizing.riskPerTrade ?? 100);
        setMaxContracts(sizing.maxContracts ?? 10);
      } else {
        setPositionSize(sizing.fixedContracts ?? s.positionSize);
      }
    }
    
    // Tracked legs
    if (s.trackedLegs) {
      setTrackedLegs(s.trackedLegs);
    }
  }, [editingStrategy]);

  // Update tracked legs when strategy type changes
  useEffect(() => {
    setTrackedLegs(getDefaultTrackedLegs(strategyType));
  }, [strategyType]);

  // Update long delta when short delta changes (default to half)
  useEffect(() => {
    if (supportsLongDelta(strategyType)) {
      setLongDeltaTarget(Math.max(0.02, shortDeltaTarget * 0.5));
    }
  }, [shortDeltaTarget, strategyType]);

  // Auto-set minPremium when strategy type changes (only if not editing existing)
  useEffect(() => {
    if (!editingStrategy) {
      setMinPremium(MIN_PREMIUM_DEFAULTS[strategyType] ?? 0.50);
    }
  }, [strategyType, editingStrategy]);

  const loadPreset = (presetName: string) => {
    const preset = STRATEGY_PRESETS[presetName as keyof typeof STRATEGY_PRESETS];
    if (!preset) return;

    setName(presetName);
    setStrategyType(preset.type);
    setUnderlying(preset.underlying);
    setMinDte(preset.dte);
    setMaxDte(preset.dte);
    setShortDeltaTarget(preset.shortDeltaTarget);
    setLongDeltaTarget(preset.longDeltaTarget ?? preset.shortDeltaTarget * 0.5);
    setWingWidth(preset.wingWidth);
    setMinPremium(preset.minPremium);
    setProfitTarget(preset.profitTarget);
    setStopLoss(preset.stopLoss);
    setCustomLegs(preset.legs as StrategyLeg[]);
    setIs0dte(preset.dte === 0);
    setSizingMode(preset.sizing.mode);
    setPositionSize(preset.sizing.fixedContracts || 1);
    setTrackedLegs(getDefaultTrackedLegs(preset.type));
  };

  const handleMaPresetChange = (presetLabel: string) => {
    setMaFilterPreset(presetLabel);
    const preset = MA_PRESETS.find(p => p.label === presetLabel);
    if (preset) {
      // Determine which SMAs are needed
      const needsSma20 = preset.rules.some(r => r.left === 'sma20' || r.right === 'sma20');
      const needsSma50 = preset.rules.some(r => r.left === 'sma50' || r.right === 'sma50');
      const needsSma200 = preset.rules.some(r => r.left === 'sma200' || r.right === 'sma200');
      
      setMaFilter({
        enabled: true,
        sma20: needsSma20,
        sma50: needsSma50,
        sma200: needsSma200,
        rules: preset.rules,
      });
    }
  };

  const toggleTrackedLeg = (role: TrackedLegRole, checked: boolean) => {
    setTrackedLegs(prev => 
      prev.map(leg => leg.role === role ? { ...leg, closeOnExit: checked } : leg)
    );
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
      shortDeltaTarget,
      longDeltaTarget: supportsLongDelta(strategyType) ? longDeltaTarget : undefined,
      minPremium: minPremium > 0 ? minPremium : undefined,
      minIvRank: useIvFilter ? minIvRank : undefined,
      maxIvRank: useIvFilter ? maxIvRank : undefined,
      marketHoursOnly,
      startTime: marketHoursOnly ? startTime : undefined,
      endTime: marketHoursOnly ? endTime : undefined,
      maFilter: useMaFilter ? maFilter : undefined,
    };

    const trailingStopConfig: TrailingStopConfig | undefined = useTrailingStop ? {
      enabled: true,
      type: trailingStopType,
      amount: trailingStopAmount,
      activationProfit: trailingStopActivation,
      basis: trailingStopBasis,
    } : undefined;

    const exitConditions: ExitConditions = {
      profitTargetPercent: profitTarget,
      stopLossPercent: stopLoss,
      timeStopDte,
      timeStopTime: is0dte ? timeStopTime : undefined,
      trailingStop: trailingStopConfig,
    };

    const sizing: StrategySizing = sizingMode === 'fixed' 
      ? { mode: 'fixed', fixedContracts: positionSize }
      : { mode: 'risk', riskPerTrade, maxContracts };

    const strategy: Omit<Strategy, 'id'> = {
      name: name || `${strategyType} - ${underlying}`,
      type: strategyType,
      underlying,
      enabled: true,
      maxPositions,
      positionSize: sizingMode === 'fixed' ? positionSize : 1,
      entryConditions,
      exitConditions,
      trackedLegs: trackedLegs.length > 0 ? trackedLegs : undefined,
      sizing,
    };

    onSaveStrategy(strategy);
  };

  const strategyInfo = STRATEGY_TYPES.find(t => t.value === strategyType);
  const currentLegs = strategyType === 'custom' ? customLegs : buildLegsFromType();
  const hasLongLegs = supportsLongDelta(strategyType);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="terminal-panel"
    >
      <div className="flex items-center justify-between border-b border-border pb-3 mb-4">
        <div>
          <h3 className="text-lg font-semibold text-foreground">
            {isEditing ? `Edit Strategy: ${editingStrategy?.name}` : 'Strategy Factory'}
          </h3>
          <p className="text-xs text-muted-foreground">
            {isEditing ? 'Modify strategy parameters and save changes' : 'Build custom strategies by selecting a template and adjusting parameters'}
          </p>
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
                      <SelectItem
                        key={type.value}
                        value={type.value}
                        disabled={type.risk === 'undefined'}
                        className={type.risk === 'undefined' ? 'text-destructive opacity-50' : ''}
                      >
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

            <div className="grid grid-cols-2 gap-4">
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
            </div>

            {/* Position Sizing */}
            <div className="space-y-3 p-3 bg-secondary/20 rounded-md">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-bloomberg-amber font-medium">Position Sizing</Label>
                <div className="flex items-center gap-2">
                  <span className={cn("text-xs", sizingMode === 'fixed' ? 'text-foreground' : 'text-muted-foreground')}>Fixed</span>
                  <Switch
                    checked={sizingMode === 'risk'}
                    onCheckedChange={(checked) => setSizingMode(checked ? 'risk' : 'fixed')}
                  />
                  <span className={cn("text-xs", sizingMode === 'risk' ? 'text-foreground' : 'text-muted-foreground')}>Risk-based</span>
                </div>
              </div>
              
              {sizingMode === 'fixed' ? (
                <div className="space-y-2">
                  <Label className="text-[10px] text-muted-foreground">Contracts per Position</Label>
                  <Input
                    type="number"
                    value={positionSize}
                    onChange={(e) => setPositionSize(parseInt(e.target.value) || 1)}
                    min={1}
                    max={100}
                    className="bg-secondary/50 border-border text-sm"
                  />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label className="text-[10px] text-muted-foreground">Risk per Trade ($)</Label>
                    <Input
                      type="number"
                      value={riskPerTrade}
                      onChange={(e) => setRiskPerTrade(parseInt(e.target.value) || 100)}
                      min={10}
                      className="bg-secondary/50 border-border text-sm"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-[10px] text-muted-foreground">Max Contracts</Label>
                    <Input
                      type="number"
                      value={maxContracts}
                      onChange={(e) => setMaxContracts(parseInt(e.target.value) || 10)}
                      min={1}
                      max={100}
                      className="bg-secondary/50 border-border text-sm"
                    />
                  </div>
                  <div className="col-span-2 text-[10px] text-muted-foreground italic">
                    Contracts calculated at entry based on max loss per contract
                  </div>
                </div>
              )}
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
                <Label className="text-xs text-bloomberg-amber font-medium">Strike Selection (Delta)</Label>
                <div className="space-y-2">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-muted-foreground">Short Strike Delta</span>
                    <span className="font-mono text-foreground">{shortDeltaTarget.toFixed(2)}</span>
                  </div>
                  <Slider
                    value={[shortDeltaTarget * 100]}
                    onValueChange={([v]) => setShortDeltaTarget(v / 100)}
                    min={5}
                    max={50}
                    step={1}
                    className="w-full"
                  />
                </div>
                {hasLongLegs && (
                  <div className="space-y-2">
                    <div className="flex justify-between text-[10px]">
                      <span className="text-muted-foreground">Long Strike Delta</span>
                      <span className="font-mono text-foreground">{longDeltaTarget.toFixed(2)}</span>
                    </div>
                    <Slider
                      value={[longDeltaTarget * 100]}
                      onValueChange={([v]) => setLongDeltaTarget(Math.max(0.02, v / 100))}
                      min={2}
                      max={Math.round(shortDeltaTarget * 100)}
                      step={1}
                      className="w-full"
                    />
                  </div>
                )}
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Wing Width (points fallback)</Label>
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

            {/* Moving Averages Filter */}
            <div className="space-y-3 p-3 bg-secondary/20 rounded-md">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-bloomberg-amber font-medium flex items-center gap-1">
                  Moving Averages Filter
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <Info className="w-3 h-3 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">Filter entries based on price vs moving average relationships</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </Label>
                <Switch
                  checked={useMaFilter}
                  onCheckedChange={setUseMaFilter}
                />
              </div>
              
              {useMaFilter && (
                <div className="space-y-3">
                  <div className="flex gap-4">
                    <div className="flex items-center gap-2">
                      <Checkbox 
                        id="sma20" 
                        checked={maFilter.sma20} 
                        onCheckedChange={(checked) => setMaFilter(prev => ({ ...prev, sma20: !!checked }))}
                      />
                      <Label htmlFor="sma20" className="text-xs">SMA20</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox 
                        id="sma50" 
                        checked={maFilter.sma50} 
                        onCheckedChange={(checked) => setMaFilter(prev => ({ ...prev, sma50: !!checked }))}
                      />
                      <Label htmlFor="sma50" className="text-xs">SMA50</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox 
                        id="sma200" 
                        checked={maFilter.sma200} 
                        onCheckedChange={(checked) => setMaFilter(prev => ({ ...prev, sma200: !!checked }))}
                      />
                      <Label htmlFor="sma200" className="text-xs">SMA200</Label>
                    </div>
                  </div>
                  
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">Filter Rule Preset</Label>
                    <Select value={maFilterPreset} onValueChange={handleMaPresetChange}>
                      <SelectTrigger className="bg-secondary/50 border-border text-xs">
                        <SelectValue placeholder="Select rule..." />
                      </SelectTrigger>
                      <SelectContent>
                        {MA_PRESETS.map((preset) => (
                          <SelectItem key={preset.label} value={preset.label}>
                            {preset.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>

            {/* Tracked Legs */}
            {trackedLegs.length > 0 && (
              <div className="space-y-3 p-3 bg-secondary/20 rounded-md">
                <Label className="text-xs text-bloomberg-amber font-medium flex items-center gap-1">
                  Tracked Legs (for exits & journaling)
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <Info className="w-3 h-3 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">Select which legs to track for exit calculations and trade journaling</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </Label>
                <div className="flex flex-wrap gap-3">
                  {trackedLegs.map((leg) => (
                    <div key={leg.role} className="flex items-center gap-2">
                      <Checkbox 
                        id={leg.role}
                        checked={leg.closeOnExit}
                        onCheckedChange={(checked) => toggleTrackedLeg(leg.role, !!checked)}
                      />
                      <Label htmlFor={leg.role} className={cn(
                        "text-xs font-mono",
                        leg.side === 'sell' ? 'text-panic-red' : 'text-trading-green'
                      )}>
                        {leg.role.replace('_', ' ')}
                      </Label>
                    </div>
                  ))}
                </div>
              </div>
            )}
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

              {/* Advanced Trailing Stop */}
              <div className="space-y-3">
                <Label className="text-xs text-bloomberg-amber font-medium">Trailing Stop</Label>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={useTrailingStop}
                    onCheckedChange={setUseTrailingStop}
                  />
                  <Label className="text-xs">Use Trailing Stop</Label>
                </div>
                {useTrailingStop && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">Type</Label>
                        <Select value={trailingStopType} onValueChange={(v) => setTrailingStopType(v as 'percent' | 'dollars')}>
                          <SelectTrigger className="bg-secondary/50 border-border text-xs h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="percent">Percent</SelectItem>
                            <SelectItem value="dollars">Dollars</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">Amount</Label>
                        <Input
                          type="number"
                          value={trailingStopAmount}
                          onChange={(e) => setTrailingStopAmount(parseFloat(e.target.value) || 0)}
                          min={1}
                          className="bg-secondary/50 border-border text-xs h-8"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Activation Profit (optional, %)</Label>
                      <Input
                        type="number"
                        value={trailingStopActivation ?? ''}
                        onChange={(e) => setTrailingStopActivation(e.target.value ? parseFloat(e.target.value) : undefined)}
                        placeholder="e.g. 20"
                        className="bg-secondary/50 border-border text-xs h-8"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Basis</Label>
                      <Select value={trailingStopBasis} onValueChange={(v) => setTrailingStopBasis(v as any)}>
                        <SelectTrigger className="bg-secondary/50 border-border text-xs h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="group">Entire Group</SelectItem>
                          <SelectItem value="tracked_legs">Tracked Legs</SelectItem>
                          <SelectItem value="short_legs">Short Legs Only</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
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
              {isEditing ? 'Save Changes' : 'Create Strategy'}
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
                {isEditing ? 'Save Custom Strategy' : 'Create Custom Strategy'}
              </Button>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </motion.div>
  );
};
