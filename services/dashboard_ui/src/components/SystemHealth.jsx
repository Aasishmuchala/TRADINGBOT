import React from 'react';

export default function SystemHealth({ health }) {
  const services = health?.services || [];
  const summary = health?.summary || {};

  const statusColors = {
    healthy: '#22c55e',
    degraded: '#f59e0b',
    down: '#ef4444',
    unknown: '#6b7280',
    error: '#ef4444',
  };

  return (
    <div style={{ background: '#0f1117', border: '1px solid #1e2030', borderRadius: '4px', padding: '12px' }}>
      <h3 style={{ margin: '0 0 8px', fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>
        System Health
        <span style={{
          marginLeft: '8px', padding: '1px 6px', borderRadius: '3px', fontSize: '10px',
          background: health?.overall === 'healthy' ? '#22c55e22' : '#ef444422',
          color: health?.overall === 'healthy' ? '#22c55e' : '#ef4444',
        }}>
          {summary.healthy || 0}/{summary.total || 0}
        </span>
      </h3>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '4px' }}>
        {services.map((svc, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 6px',
            fontSize: '10px', fontFamily: 'monospace', color: '#94a3b8',
          }}>
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: statusColors[svc.status],
              flexShrink: 0,
            }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {svc.service.replace('_', '-')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}