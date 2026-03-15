import React, { useState } from 'react';

export default function MainChart({ regime }) {
  const [selectedAsset, setSelectedAsset] = useState('BTC/USDT');
  const [selectedTimeframe, setSelectedTimeframe] = useState('1h');

  const assets = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'];
  const timeframes = ['1m', '5m', '15m', '1h', '4h'];

  const regimeColors = {
    trending: 'rgba(59, 130, 246, 0.1)',
    ranging: 'rgba(168, 85, 247, 0.1)',
    high_vol: 'rgba(239, 68, 68, 0.1)',
    low_vol: 'rgba(34, 197, 94, 0.1)',
  };

  return (
    <div style={{
      background: '#0f1117', border: '1px solid #1e2030', borderRadius: '4px', padding: '12px',
      gridColumn: 'span 2',
    }}>
      {/* Controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
        <div style={{ display: 'flex', gap: '4px' }}>
          {assets.map(a => (
            <button key={a} onClick={() => setSelectedAsset(a)} style={{
              padding: '2px 8px', fontSize: '11px', fontFamily: 'monospace',
              background: selectedAsset === a ? '#3b82f6' : '#1e2030',
              color: selectedAsset === a ? '#fff' : '#94a3b8',
              border: 'none', borderRadius: '3px', cursor: 'pointer',
            }}>{a.split('/')[0]}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          {timeframes.map(tf => (
            <button key={tf} onClick={() => setSelectedTimeframe(tf)} style={{
              padding: '2px 6px', fontSize: '11px', fontFamily: 'monospace',
              background: selectedTimeframe === tf ? '#3b82f6' : '#1e2030',
              color: selectedTimeframe === tf ? '#fff' : '#94a3b8',
              border: 'none', borderRadius: '3px', cursor: 'pointer',
            }}>{tf}</button>
          ))}
        </div>
      </div>

      {/* Chart placeholder — integrate lightweight-charts in production */}
      <div style={{
        height: '300px', background: regimeColors[regime?.regime] || '#0a0d14',
        border: '1px solid #1e2030', borderRadius: '4px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#475569', fontSize: '13px', fontFamily: 'monospace',
      }}>
        {selectedAsset} · {selectedTimeframe} · Regime: {regime?.regime || 'unknown'}
        <br />
        Connect lightweight-charts for live candlestick rendering
      </div>
    </div>
  );
}