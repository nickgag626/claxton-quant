import { useTradingData } from '@/hooks/useTradingData';
import { Header } from '@/components/dashboard/Header';
import { StatusRibbon } from '@/components/dashboard/StatusRibbon';
import { KPIStrip } from '@/components/dashboard/KPIStrip';
import { PositionsPanel } from '@/components/dashboard/PositionsPanel';
import { ControlsPanel } from '@/components/dashboard/ControlsPanel';
import { ActivityLog } from '@/components/dashboard/ActivityLog';
import { StrategiesPanel } from '@/components/dashboard/StrategiesPanel';
import { PnLChart } from '@/components/dashboard/PnLChart';
import { DataLagWarning } from '@/components/dashboard/DataLagWarning';

const Index = () => {
  const {
    positions,
    greeks,
    quotes,
    strategies,
    riskStatus,
    activity,
    marketState,
    isApiConnected,
    isBotRunning,
    lastUpdate,
    toggleBot,
    toggleKillSwitch,
    toggleStrategy,
  } = useTradingData();

  const enabledStrategiesCount = strategies.filter(s => s.enabled).length;
  const nearestDte = positions.length > 0 ? 11 : null; // Mock value

  const handleEmergencyClose = () => {
    console.log('Emergency close triggered');
  };

  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <div className="max-w-7xl mx-auto space-y-4">
        <Header />
        
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
            <PositionsPanel positions={positions} isApiConnected={isApiConnected} />
            <PnLChart dailyPnl={riskStatus.dailyPnl} />
          </div>
          <div>
            <ControlsPanel
              greeks={greeks}
              riskStatus={riskStatus}
              isBotRunning={isBotRunning}
              onToggleBot={toggleBot}
              onToggleKillSwitch={toggleKillSwitch}
              onEmergencyClose={handleEmergencyClose}
            />
          </div>
        </div>
        
        <StrategiesPanel strategies={strategies} onToggleStrategy={toggleStrategy} />
        
        <ActivityLog events={activity} />
      </div>
    </div>
  );
};

export default Index;
