import React, { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import Header from './components/Header';
import Positions from './components/Positions';
import MainChart from './components/MainChart';
import StrategyFeed from './components/StrategyFeed';
import OrderBooks from './components/OrderBooks';
import RiskDashboard from './components/RiskDashboard';
import SystemHealth from './components/SystemHealth';
import Settings from './components/Settings';

const API_BASE = '/api';

export default function App() {
  const { lastMessage, connectionStatus } = useWebSocket();

  // Page state
  const [page, setPage] = useState('dashboard'); // 'dashboard' | 'settings'

  // State
  const [positions, setPositions] = useState({ positions: [] });
  const [pnl, setPnl] = useState({ daily_pnl: 0, trade_count: 0 });
  const [regime, setRegime] = useState({ regime: 'unknown', confidence: 0 });
  const [strategies, setStrategies] = useState([]);
  const [signals, setSignals] = useState([]);
  const [health, setHealth] = useState({ services: [], summary: {} });
  const [latency, setLatency] = useState([]);
  const [orderbook, setOrderbook] = useState({ bids: [], asks: [] });

  // Initial data fetch
  const fetchData = useCallback(async () => {
    try {
      const [posRes, pnlRes, stratRes, healthRes, latRes, regimeRes] = await Promise.all([
        fetch(`${API_BASE}/portfolio/positions`).catch(() => null),
        fetch(`${API_BASE}/portfolio/pnl`).catch(() => null),
        fetch(`${API_BASE}/strategies/performance`).catch(() => null),
        fetch(`${API_BASE}/health/status`).catch(() => null),
        fetch(`${API_BASE}/health/latency`).catch(() => null),
        fetch(`${API_BASE}/strategies/regime`).catch(() => null),
      ]);

      if (posRes?.ok) setPositions(await posRes.json());
      if (pnlRes?.ok) setPnl(await pnlRes.json());
      if (stratRes?.ok) setStrategies(await stratRes.json());
      if (healthRes?.ok) setHealth(await healthRes.json());
      if (latRes?.ok) setLatency(await latRes.json());
      if (regimeRes?.ok) setRegime(await regimeRes.json());
    } catch (e) {
      console.error('Fetch error:', e);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000); // Poll every 10s
    return () => clearInterval(interval);
  }, [fetchData]);

  // Handle WebSocket messages
  useEffect(() => {
    if (!lastMessage) return;
    const { channel, data } = lastMessage;

    switch (channel) {
      case 'portfolio_updates':
        if (data.type === 'snapshot') setPositions(data);
        break;
      case 'regime_signal':
        setRegime(data);
        break;
      case 'strategy_signals':
        setSignals(prev => [data, ...prev].slice(0, 100));
        break;
      case 'latency_updates':
        setLatency(prev => {
          const updated = [...prev];
          const idx = updated.findIndex(l => l.exchange === data.exchange);
          if (idx >= 0) updated[idx] = { ...updated[idx], latency_ms: data.rtt_ms };
          return updated;
        });
        break;
      case 'fill_reports':
        setPnl(prev => ({
          ...prev,
          trade_count: prev.trade_count + 1,
        }));
        break;
    }
  }, [lastMessage]);

  return (
    <div style={{ background: '#080a0f', color: '#e2e8f0', minHeight: '100vh', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <Header connectionStatus={connectionStatus} regime={regime} pnl={pnl} onSettingsClick={() => setPage('settings')} />

      {page === 'settings' ? (
        <Settings onBack={() => setPage('dashboard')} />
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: '8px',
          padding: '8px',
          maxWidth: '1800px',
          margin: '0 auto',
        }}>
          {/* Row 1: Chart (2 cols) + Positions */}
          <MainChart regime={regime} />
          <Positions positions={positions} />

          {/* Row 2: Strategies + Risk + System Health */}
          <StrategyFeed signals={signals} strategies={strategies} />
          <RiskDashboard pnl={pnl} health={health} latency={latency} />
          <SystemHealth health={health} />

          {/* Row 3: Order Books */}
          <OrderBooks orderbook={orderbook} />
        </div>
      )}
    </div>
  );
}