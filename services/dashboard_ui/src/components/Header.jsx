import React, { useState, useEffect } from 'react';

export default function Header({ connectionStatus, regime, pnl, onSettingsClick }) {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const statusColor = {
    connected: '#22c55e',
    disconnected: '#ef4444',
    connecting: '#f59e0b',
    error: '#ef4444',
  }[connectionStatus] || '#6b7280';

  const regimeColors = {
    trending: '#3b82f6',
    ranging: '#a855f7',
    high_vol: '#ef4444',
    low_vol: '#22c55e',
    unknown: '#6b7280',
  };

  return (
    <header style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '8px 16px', background: '#0f1117', borderBottom: '1px solid #1e2030',
      fontFamily: 'monospace', fontSize: '13px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <span style={{ fontWeight: 'bold', fontSize: '15px', color: '#e2e8f0' }}>
          CRYPTO TRADING BOT
        </span>
        <span style={{
          padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold',
          background: regimeColors[regime?.regime || 'unknown'] + '22',
          color: regimeColors[regime?.regime || 'unknown'],
          border: `1px solid ${regimeColors[regime?.regime || 'unknown']}44`,
        }}>
          {(regime?.regime || 'UNKNOWN').toUpperCase()}
          {regime?.confidence ? ` ${(regime.confidence * 100).toFixed(0)}%` : ''}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '20px', color: '#94a3b8' }}>
        <span style={{ color: (pnl?.daily_pnl || 0) >= 0 ? '#22c55e' : '#ef4444' }}>
          P&L: ${(pnl?.daily_pnl || 0).toFixed(2)}
        </span>
        <span>Trades: {pnl?.trade_count || 0}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{
            width: '8px', height: '8px', borderRadius: '50%', background: statusColor,
            display: 'inline-block',
          }} />
          {connectionStatus}
        </span>
        <span>{time.toUTCString().slice(17, 25)} UTC</span>
        <button onClick={onSettingsClick} style={{
          background: 'none', border: '1px solid #374151', borderRadius: '6px',
          padding: '4px 10px', cursor: 'pointer', color: '#94a3b8', fontSize: '14px',
          transition: 'all 0.15s',
        }} title="Settings">
          ⚙ Settings
        </button>
      </div>
    </header>
  );
}