import React from 'react';

export default function Positions({ positions }) {
  const items = positions?.positions || [];

  return (
    <div style={{ background: '#0f1117', border: '1px solid #1e2030', borderRadius: '4px', padding: '12px' }}>
      <h3 style={{ margin: '0 0 8px', fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>
        Open Positions ({items.length})
      </h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', fontFamily: 'monospace' }}>
          <thead>
            <tr style={{ color: '#64748b', borderBottom: '1px solid #1e2030' }}>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Asset</th>
              <th style={{ textAlign: 'right', padding: '4px 8px' }}>Side</th>
              <th style={{ textAlign: 'right', padding: '4px 8px' }}>Qty</th>
              <th style={{ textAlign: 'right', padding: '4px 8px' }}>Avg Cost</th>
              <th style={{ textAlign: 'right', padding: '4px 8px' }}>Unrealized</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan="5" style={{ padding: '12px', color: '#475569', textAlign: 'center' }}>No open positions</td></tr>
            ) : (
              items.map((pos, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #1e203044' }}>
                  <td style={{ padding: '4px 8px', color: '#e2e8f0' }}>{pos.asset}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right', color: pos.side === 'long' ? '#22c55e' : '#ef4444' }}>
                    {pos.side?.toUpperCase()}
                  </td>
                  <td style={{ padding: '4px 8px', textAlign: 'right', color: '#cbd5e1' }}>{pos.qty}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right', color: '#cbd5e1' }}>${pos.avg_cost?.toFixed(2)}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right', color: (pos.unrealized_pnl || 0) >= 0 ? '#22c55e' : '#ef4444' }}>
                    ${(pos.unrealized_pnl || 0).toFixed(2)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}