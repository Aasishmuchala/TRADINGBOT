import React from 'react';

export default function StrategyFeed({ signals, strategies }) {
  return (
    <div style={{ background: '#0f1117', border: '1px solid #1e2030', borderRadius: '4px', padding: '12px' }}>
      <h3 style={{ margin: '0 0 8px', fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>
        Strategy Feed
      </h3>

      {/* Strategy weights */}
      <div style={{ marginBottom: '12px' }}>
        {(strategies || []).map((s, i) => (
          <div key={i} style={{
            display: 'flex', justifyContent: 'space-between', padding: '3px 0',
            fontSize: '11px', fontFamily: 'monospace', color: '#94a3b8',
          }}>
            <span>{s.strategy}</span>
            <span style={{ color: s.total_pnl >= 0 ? '#22c55e' : '#ef4444' }}>
              ${s.total_pnl?.toFixed(2)} | WR: {s.win_rate}%
            </span>
          </div>
        ))}
      </div>

      {/* Signal log */}
      <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
        {(signals || []).slice(0, 20).map((sig, i) => (
          <div key={i} style={{
            padding: '3px 6px', marginBottom: '2px', fontSize: '11px',
            fontFamily: 'monospace', borderLeft: `2px solid ${sig.signal === 'buy' ? '#22c55e' : '#ef4444'}`,
            background: '#1e203022', color: '#94a3b8',
          }}>
            <span style={{ color: sig.signal === 'buy' ? '#22c55e' : '#ef4444' }}>
              {sig.signal?.toUpperCase()}
            </span>
            {' '}{sig.asset} via {sig.strategy}
            {' '}({(sig.confidence * 100).toFixed(0)}%)
          </div>
        ))}
      </div>
    </div>
  );
}