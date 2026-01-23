import { useTradingData } from '@/hooks/useTradingData';
import { Header } from '@/components/dashboard/Header';
import { StatusRibbon } from '@/components/dashboard/StatusRibbon';
import { KPIStrip } from '@/components/dashboard/KPIStrip';
import { PositionsPanel } from '@/components/dashboard/PositionsPanel';
import { ControlsPanel } from '@/components/dashboard/ControlsPanel';
import { ActivityLog } from '@/components/dashboard/ActivityLog';
import { StrategiesPanel } from '@/components/dashboard/StrategiesPanel';
import { PnLChart } from '@/components/dashboard/PnLChart';
import { GreeksChart } from '@/components/dashboard/GreeksChart';
import { DataLagWarning } from '@/components/dashboard/DataLagWarning';
import { TradeJournal } from '@/components/dashboard/TradeJournal';
import { OptionsChain } from '@/components/dashboard/OptionsChain';
import { RecoveryPanel } from '@/components/dashboard/RecoveryPanel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { BookOpen, Grid3X3, Activity, AlertTriangle, RefreshCw, WifiOff, Loader2 } from 'lucide-react';

const Index = () => {
  const {
    positions,
    greeks,
    quotes,
    strategies,
    riskStatus,
    safeguards,
    activity,
    marketState,
    isApiConnected,
    isBotRunning,
    lastUpdate,
    lastCheckExitsTime,
    deltaHistory,
    pnlHistory,
    isLoading,
    error,
    toggleBot,
    toggleKillSwitch,
    updateRiskSettings,
    updateSafeguards,
    toggleStrategy,
    addStrategy,
    updateStrategy,
    deleteStrategy,
    closePosition,
    emergencyCloseAll,
    closeDebugOptions,
    setCloseDebugOptions,
    lastCloseDebug,
    copyLastCloseDebug,
    // Group-aware closing
    legOutModeEnabled,
    setLegOutModeEnabled,
    closeGroup,
    retryCloseAsGroup,
    dtbpRejection,
    isGroupedPosition,
    getGroupPositions,
    getExitStatus,
    clearHistory,
    // Structure Integrity Gate
    entryBlockedReason,
    clearEntryBlock,
    // Mapping maintenance
    purgeStaleMappings,
    // Wide spread block confirmation
    wideSpreadBlock,
    forceCloseGroup,
    clearWideSpreadBlock,
    // Refetch
    refetch,
  } = useTradingData();

  const enabledStrategiesCount = strategies.filter(s => s.enabled).length;
  const nearestDte = positions.length > 0 ? 11 : null; // Mock value

  // Show loading state during initial load
  if (isLoading && !isApiConnected && positions.length === 0) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center space-y-4">
          <Loader2 className="h-12 w-12 animate-spin text-muted-foreground mx-auto" />
          <p className="text-muted-foreground">Connecting to trading API...</p>
        </div>
      </div>
    );
  }

  // Show error banner (not blocking) when API has issues but we have some data
  const showErrorBanner = error && !isApiConnected;

  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <div className="max-w-7xl mx-auto space-y-4">
        <Header />
        
        {/* API Error Banner - shown but doesn't block UI */}
        {showErrorBanner && (
          <Alert variant="destructive" className="border-destructive/50 bg-destructive/10">
            <WifiOff className="h-4 w-4" />
            <AlertTitle className="flex items-center gap-2">
              API Connection Issue
            </AlertTitle>
            <AlertDescription className="flex items-center justify-between">
              <span className="text-sm">{error || 'Unable to connect to trading API. Retrying automatically...'}</span>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={refetch}
                className="ml-4 shrink-0"
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Retry Now
              </Button>
            </AlertDescription>
          </Alert>
        )}
        
        <DataLagWarning />
        
        <StatusRibbon
          isApiConnected={isApiConnected}
          isQuotesLive={true}
          isBotRunning={isBotRunning}
          killSwitchActive={riskStatus.killSwitchActive}
          marketState={marketState}
          positionCount={positions.length}
          nearestDte={nearestDte}
          lastUpdate={lastUpdate}
          lastCheckExitsTime={lastCheckExitsTime}
        />
        
        <KPIStrip
          riskStatus={riskStatus}
          greeks={greeks}
          quotes={quotes}
          enabledStrategiesCount={enabledStrategiesCount}
          positionCount={positions.length}
        />
        
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">
            <PositionsPanel
              positions={positions}
              isApiConnected={isApiConnected}
              onClosePosition={closePosition}
              onCloseGroup={closeGroup}
              legOutModeEnabled={legOutModeEnabled}
              onLegOutModeChange={setLegOutModeEnabled}
              isGroupedPosition={isGroupedPosition}
              getGroupPositions={getGroupPositions}
              getExitStatus={getExitStatus}
              dtbpRejection={dtbpRejection}
              onRetryCloseAsGroup={retryCloseAsGroup}
              entryBlockedReason={entryBlockedReason}
              onClearEntryBlock={clearEntryBlock}
              onPurgeStaleMappings={purgeStaleMappings}
              wideSpreadBlock={wideSpreadBlock}
              onForceCloseGroup={forceCloseGroup}
              onClearWideSpreadBlock={clearWideSpreadBlock}
            />
            <PnLChart dailyPnl={riskStatus.dailyPnl} pnlHistory={pnlHistory} />
            <GreeksChart currentDelta={greeks.delta} deltaHistory={deltaHistory} />
          </div>
          <div>
            <ControlsPanel
              greeks={greeks}
              riskStatus={riskStatus}
              safeguards={safeguards}
              isBotRunning={isBotRunning}
              onToggleBot={toggleBot}
              onToggleKillSwitch={toggleKillSwitch}
              onEmergencyClose={emergencyCloseAll}
              onUpdateRiskSettings={updateRiskSettings}
              onUpdateSafeguards={updateSafeguards}
              closeDebugOptions={closeDebugOptions}
              onCloseDebugOptionsChange={setCloseDebugOptions}
              lastCloseDebug={lastCloseDebug}
              onCopyCloseDebug={copyLastCloseDebug}
            />
          </div>
        </div>
        
        <StrategiesPanel 
          strategies={strategies} 
          onToggleStrategy={toggleStrategy}
          onAddStrategy={addStrategy}
          onUpdateStrategy={updateStrategy}
          onDeleteStrategy={deleteStrategy}
        />
        
        <Tabs defaultValue="journal" className="w-full">
          <TabsList className="grid w-full grid-cols-4 max-w-lg">
            <TabsTrigger value="journal" className="flex items-center gap-2">
              <BookOpen className="h-4 w-4" />
              <span className="hidden sm:inline">Trade Journal</span>
              <span className="sm:hidden">Journal</span>
            </TabsTrigger>
            <TabsTrigger value="chain" className="flex items-center gap-2">
              <Grid3X3 className="h-4 w-4" />
              <span className="hidden sm:inline">Options Chain</span>
              <span className="sm:hidden">Chain</span>
            </TabsTrigger>
            <TabsTrigger value="recovery" className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              <span className="hidden sm:inline">Recovery</span>
              <span className="sm:hidden">Recover</span>
            </TabsTrigger>
            <TabsTrigger value="activity" className="flex items-center gap-2">
              <Activity className="h-4 w-4" />
              <span className="hidden sm:inline">Activity Log</span>
              <span className="sm:hidden">Activity</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="journal" className="mt-4">
            <TradeJournal />
          </TabsContent>
          <TabsContent value="chain" className="mt-4">
            <OptionsChain />
          </TabsContent>
          <TabsContent value="recovery" className="mt-4">
            <RecoveryPanel onRefresh={refetch} />
          </TabsContent>
          <TabsContent value="activity" className="mt-4">
            <ActivityLog events={activity} onClearHistory={clearHistory} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
};

export default Index;
