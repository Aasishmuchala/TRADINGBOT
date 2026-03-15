import React from 'react';

export default function RiskDashboard({ pnl, health, latency }) {
  const drawdown = pnl?.daily_pnl < 0 ? Math.abs(pnl.daily_pnl) : 0;
  const drawdownPct = drawdown / 10000 * 100; // Assuming 10k capital

  return (
    <div style={{ background: '#0f1117', border: '1px solid #1e2030', borderRadius: '4px', padding: '12px' }}>
      <h3 style={{ margin: '0 0 8px', fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>
        Risk Dashboard
      </h3>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '11px', fontFamily: 'monospace' }}>
        {/* Daily Drawdown */}
        <div style={{ padding: '8px', background: '#1e2030', borderRadius: '4px' }}>
          <div style={{ color: '#64748b', marginBottom: '4px' }}>Daily Drawdown</div>
          <div style={{ fontSize: '16px', color: drawdownPct > 2 ? '#ef4444' : '#22c55e' }}>
            {drawdownPct.toFixed(2)}%
          </div>
          <div style={{ height: '4px', background: '#374151', borderRadius: '2px', marginTop: '4px' }}>
            <div style={{
              height: '100%', borderRadius: '2px', width: `${Math.min(drawdownPct / 3 * 100, 100)}%`,
              background: drawdownPct > 2 ? '#ef4444' : drawdownPct > 1 ? '#f59e0b' : '#22c55e',
            }} />
          </div>
        </div>

        {/* Portfolio Heat */}
        <div style={{ padding: '8px', background: '#1e2030', borderRadius: '4px' }}>
          <div style={{ color: '#64748b', marginBottom: '4px' }}>Portfolio Heat</div>
          <div style={{ fontSize: '16px', color: '#f59e0b' }}>
            {((pnl?.total_exposure || 0) / 10000 * 100).toFixed(1)}%
          </div>
          <div style={{ color: '#475569', marginTop: '2px' }}>of 30% limit</div>
        </div>

        {/* Exchange Latency */}
        {(latency || []).map((ex, i) => (
          <div key={i} style={{ padding: '8px', background: '#1e2030', borderRadius: '4px' }}>
            <div style={{ color: '#64748b', marginBottom: '4px' }}>{ex.exchange}</div>
            <div style={{
              fontSize: '16px',
              color: (ex.latency_ms || 9999) < 200 ? '#22c55e' : (ex.latency_ms || 9999) < 500 ? '#f59e0b' : '#ef4444',
            }}>
              {ex.latency_ms ? `${ex.latency_ms.toFixed(0)}ms` : 'N/A'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}