import React from 'react';

export default function OrderBooks({ orderbook }) {
  const bids = orderbook?.bids || [];
  const asks = orderbook?.asks || [];
  const maxQty = Math.max(
    ...bids.map(b => b[1] || 0),
    ...asks.map(a => a[1] || 0),
    1
  );

  return (
    <div style={{ background: '#0f1117', border: '1px solid #1e2030', borderRadius: '4px', padding: '12px' }}>
      <h3 style={{ margin: '0 0 8px', fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>
        Order Book
      </h3>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '11px', fontFamily: 'monospace' }}>
        {/* Bids */}
        <div>
          <div style={{ color: '#64748b', marginBottom: '4px', fontSize: '10px' }}>BIDS</div>
          {bids.slice(0, 10).map((bid, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0', position: 'relative' }}>
              <div style={{
                position: 'absolute', right: 0, top: 0, bottom: 0,
                width: `${(bid[1] / maxQty) * 100}%`,
                background: 'rgba(34, 197, 94, 0.08)',
              }} />
              <span style={{ color: '#22c55e', zIndex: 1 }}>{bid[0]?.toFixed(2)}</span>
              <span style={{ color: '#64748b', zIndex: 1 }}>{bid[1]?.toFixed(4)}</span>
            </div>
          ))}
        </div>

        {/* Asks */}
        <div>
          <div style={{ color: '#64748b', marginBottom: '4px', fontSize: '10px' }}>ASKS</div>
          {asks.slice(0, 10).map((ask, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0', position: 'relative' }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${(ask[1] / maxQty) * 100}%`,
                background: 'rgba(239, 68, 68, 0.08)',
              }} />
              <span style={{ color: '#ef4444', zIndex: 1 }}>{ask[0]?.toFixed(2)}</span>
              <span style={{ color: '#64748b', zIndex: 1 }}>{ask[1]?.toFixed(4)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}