import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = '/api';

// ── Styles ───────────────────────────────────────────────────────────

const card = {
  background: '#111827',
  border: '1px solid #1f2937',
  borderRadius: '8px',
  padding: '20px',
  marginBottom: '16px',
};

const sectionTitle = {
  fontSize: '16px',
  fontWeight: 700,
  color: '#f9fafb',
  marginBottom: '16px',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
};

const label = {
  fontSize: '12px',
  fontWeight: 600,
  color: '#9ca3af',
  marginBottom: '4px',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const input = {
  width: '100%',
  padding: '10px 12px',
  background: '#0d1117',
  border: '1px solid #374151',
  borderRadius: '6px',
  color: '#e5e7eb',
  fontSize: '14px',
  fontFamily: 'JetBrains Mono, monospace',
  outline: 'none',
  boxSizing: 'border-box',
};

const inputFocus = {
  ...input,
  borderColor: '#3b82f6',
  boxShadow: '0 0 0 2px rgba(59,130,246,0.2)',
};

const btnPrimary = {
  padding: '10px 20px',
  background: '#2563eb',
  color: '#fff',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: '14px',
  transition: 'background 0.15s',
};

const btnSecondary = {
  padding: '10px 20px',
  background: 'transparent',
  color: '#9ca3af',
  border: '1px solid #374151',
  borderRadius: '6px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: '14px',
  transition: 'all 0.15s',
};

const btnTest = {
  padding: '8px 14px',
  background: '#065f46',
  color: '#6ee7b7',
  border: '1px solid #059669',
  borderRadius: '6px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: '12px',
};

const statusDot = (ok) => ({
  width: '8px',
  height: '8px',
  borderRadius: '50%',
  background: ok ? '#10b981' : '#ef4444',
  display: 'inline-block',
});

const badge = (color) => ({
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: '4px',
  fontSize: '11px',
  fontWeight: 700,
  background: color === 'green' ? '#064e3b' : color === 'yellow' ? '#78350f' : '#7f1d1d',
  color: color === 'green' ? '#6ee7b7' : color === 'yellow' ? '#fbbf24' : '#fca5a5',
});

const toggleContainer = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  cursor: 'pointer',
};

const toggleTrack = (on) => ({
  width: '44px',
  height: '24px',
  borderRadius: '12px',
  background: on ? '#2563eb' : '#374151',
  position: 'relative',
  transition: 'background 0.2s',
  cursor: 'pointer',
});

const toggleKnob = (on) => ({
  width: '18px',
  height: '18px',
  borderRadius: '50%',
  background: '#fff',
  position: 'absolute',
  top: '3px',
  left: on ? '23px' : '3px',
  transition: 'left 0.2s',
});


// ── Sub-Components ───────────────────────────────────────────────────

function InputField({ labelText, value, onChange, type = 'text', placeholder = '', mono = true }) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ marginBottom: '12px' }}>
      <div style={label}>{labelText}</div>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={focused ? inputFocus : input}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
    </div>
  );
}

function Toggle({ on, onChange, labelText }) {
  return (
    <div style={toggleContainer} onClick={() => onChange(!on)}>
      <div style={toggleTrack(on)}>
        <div style={toggleKnob(on)} />
      </div>
      <span style={{ color: '#e5e7eb', fontSize: '14px', fontWeight: 500 }}>{labelText}</span>
    </div>
  );
}


// ── Exchange Card ────────────────────────────────────────────────────

function ExchangeCard({ name, displayName, icon, data, onSave, onTest, testResult, saving }) {
  const [keys, setKeys] = useState({ api_key: '', api_secret: '', passphrase: '' });
  const [editing, setEditing] = useState(false);
  const hasKeys = data?.has_key && data?.has_secret;
  const needsPassphrase = name === 'kucoin';

  const handleSave = () => {
    onSave(name, keys);
    setKeys({ api_key: '', api_secret: '', passphrase: '' });
    setEditing(false);
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={sectionTitle}>
          <span style={{ fontSize: '20px' }}>{icon}</span>
          {displayName}
          {hasKeys
            ? <span style={badge('green')}>CONFIGURED</span>
            : <span style={badge('red')}>NO KEYS</span>
          }
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {hasKeys && (
            <button style={btnTest} onClick={() => onTest(name)}
              disabled={testResult?.loading}>
              {testResult?.loading ? '⏳ Testing...' : '🔗 Test Connection'}
            </button>
          )}
        </div>
      </div>

      {/* Show masked current keys if configured */}
      {hasKeys && !editing && (
        <div style={{ marginBottom: '12px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: needsPassphrase ? '1fr 1fr 1fr' : '1fr 1fr', gap: '12px' }}>
            <div>
              <div style={label}>API Key</div>
              <div style={{ ...input, background: '#0a0e14', color: '#6b7280' }}>{data.api_key || '—'}</div>
            </div>
            <div>
              <div style={label}>API Secret</div>
              <div style={{ ...input, background: '#0a0e14', color: '#6b7280' }}>{data.api_secret || '—'}</div>
            </div>
            {needsPassphrase && (
              <div>
                <div style={label}>Passphrase</div>
                <div style={{ ...input, background: '#0a0e14', color: '#6b7280' }}>{data.passphrase || '—'}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Test result */}
      {testResult && !testResult.loading && (
        <div style={{
          padding: '10px 14px',
          borderRadius: '6px',
          marginBottom: '12px',
          background: testResult.connected ? '#064e3b' : '#7f1d1d',
          border: `1px solid ${testResult.connected ? '#059669' : '#dc2626'}`,
          fontSize: '13px',
          color: testResult.connected ? '#6ee7b7' : '#fca5a5',
        }}>
          {testResult.connected
            ? `Connected — USDT Balance: ${testResult.usdt_balance ?? 'N/A'}`
            : `Failed: ${testResult.error}`
          }
        </div>
      )}

      {/* Edit / Add keys form */}
      {(editing || !hasKeys) && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: needsPassphrase ? '1fr 1fr 1fr' : '1fr 1fr', gap: '12px' }}>
            <InputField
              labelText="API Key"
              value={keys.api_key}
              onChange={v => setKeys(p => ({ ...p, api_key: v }))}
              placeholder="Paste your API key"
            />
            <InputField
              labelText="API Secret"
              value={keys.api_secret}
              onChange={v => setKeys(p => ({ ...p, api_secret: v }))}
              placeholder="Paste your API secret"
              type="password"
            />
            {needsPassphrase && (
              <InputField
                labelText="Passphrase"
                value={keys.passphrase}
                onChange={v => setKeys(p => ({ ...p, passphrase: v }))}
                placeholder="Your trading passphrase"
                type="password"
              />
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
            <button style={btnPrimary} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : `Save ${displayName} Keys`}
            </button>
            {hasKeys && (
              <button style={btnSecondary} onClick={() => { setEditing(false); setKeys({ api_key: '', api_secret: '', passphrase: '' }); }}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {hasKeys && !editing && (
        <button style={{ ...btnSecondary, marginTop: '8px', fontSize: '12px', padding: '6px 12px' }}
          onClick={() => setEditing(true)}>
          Update Keys
        </button>
      )}
    </div>
  );
}


// ── Main Settings Component ──────────────────────────────────────────

export default function Settings({ onBack }) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testResults, setTestResults] = useState({});
  const [toast, setToast] = useState(null);

  // Alert settings form state
  const [alerts, setAlerts] = useState({
    telegram_bot_token: '', telegram_chat_id: '',
    smtp_host: '', smtp_port: 587, smtp_user: '', smtp_pass: '', alert_email: '',
  });

  // Trading params form state
  const [trading, setTrading] = useState({
    initial_capital: 10000, max_leverage: 2.0, daily_drawdown_limit: 0.03,
    portfolio_heat_limit: 0.30, kelly_fraction: 0.5, per_asset_limit: 0.15,
    paper_mode: true,
  });

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Fetch current settings
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/settings`);
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
        // Populate trading params from server
        setTrading({
          initial_capital: data.trading.initial_capital,
          max_leverage: data.trading.max_leverage,
          daily_drawdown_limit: data.trading.daily_drawdown_limit,
          portfolio_heat_limit: data.trading.portfolio_heat_limit,
          kelly_fraction: data.trading.kelly_fraction,
          per_asset_limit: data.trading.per_asset_limit,
          paper_mode: data.trading.paper_mode,
        });
        // Populate alerts (non-secret fields)
        setAlerts(prev => ({
          ...prev,
          telegram_chat_id: data.alerts.telegram_chat_id || '',
          smtp_host: data.alerts.smtp_host || '',
          smtp_port: data.alerts.smtp_port || 587,
          smtp_user: data.alerts.smtp_user || '',
          alert_email: data.alerts.alert_email || '',
        }));
      }
    } catch (e) {
      console.error('Failed to fetch settings:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  // Save exchange keys
  const saveExchangeKeys = async (exchange, keys) => {
    setSaving(true);
    try {
      const body = { api_key: keys.api_key, api_secret: keys.api_secret };
      if (exchange === 'kucoin' && keys.passphrase) body.passphrase = keys.passphrase;

      const res = await fetch(`${API_BASE}/settings/exchange/${exchange}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        showToast(`${exchange.charAt(0).toUpperCase() + exchange.slice(1)} keys saved`);
        await fetchSettings(); // Refresh masked view
      } else {
        showToast('Failed to save keys', 'error');
      }
    } catch (e) {
      showToast(`Error: ${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // Test exchange connection
  const testConnection = async (exchange) => {
    setTestResults(prev => ({ ...prev, [exchange]: { loading: true } }));
    try {
      const res = await fetch(`${API_BASE}/settings/test-connection/${exchange}`, { method: 'POST' });
      const data = await res.json();
      setTestResults(prev => ({ ...prev, [exchange]: data }));
    } catch (e) {
      setTestResults(prev => ({
        ...prev, [exchange]: { connected: false, error: e.message },
      }));
    }
  };

  // Save trading params
  const saveTradingParams = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/settings/trading`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trading),
      });
      if (res.ok) showToast('Trading parameters saved');
      else showToast('Failed to save', 'error');
    } catch (e) {
      showToast(`Error: ${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // Save alerts
  const saveAlerts = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/settings/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alerts),
      });
      if (res.ok) showToast('Alert settings saved');
      else showToast('Failed to save', 'error');
    } catch (e) {
      showToast(`Error: ${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <div style={{ color: '#6b7280', fontSize: '16px' }}>Loading settings...</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '960px', margin: '0 auto', padding: '20px' }}>

      {/* Toast Notification */}
      {toast && (
        <div style={{
          position: 'fixed', top: '20px', right: '20px', zIndex: 1000,
          padding: '12px 20px', borderRadius: '8px',
          background: toast.type === 'success' ? '#064e3b' : '#7f1d1d',
          border: `1px solid ${toast.type === 'success' ? '#059669' : '#dc2626'}`,
          color: toast.type === 'success' ? '#6ee7b7' : '#fca5a5',
          fontWeight: 600, fontSize: '14px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
        }}>
          {toast.type === 'success' ? '✓ ' : '✕ '}{toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
        <button onClick={onBack} style={{
          ...btnSecondary, padding: '8px 14px', fontSize: '13px',
        }}>
          ← Dashboard
        </button>
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#f9fafb', margin: 0 }}>
          Settings
        </h1>
        {!settings?.env_file_exists && (
          <span style={badge('yellow')}>NO .env FILE — Settings will create one</span>
        )}
      </div>

      {/* ── Exchange API Keys ─────────────────────── */}
      <h2 style={{ fontSize: '14px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '12px' }}>
        Exchange API Keys
      </h2>

      <ExchangeCard
        name="binance" displayName="Binance" icon="🟡"
        data={settings?.binance}
        onSave={saveExchangeKeys} onTest={testConnection}
        testResult={testResults.binance} saving={saving}
      />
      <ExchangeCard
        name="bybit" displayName="Bybit" icon="🟠"
        data={settings?.bybit}
        onSave={saveExchangeKeys} onTest={testConnection}
        testResult={testResults.bybit} saving={saving}
      />
      <ExchangeCard
        name="kucoin" displayName="KuCoin" icon="🟢"
        data={settings?.kucoin}
        onSave={saveExchangeKeys} onTest={testConnection}
        testResult={testResults.kucoin} saving={saving}
      />

      {/* IP Allowlist Reminder */}
      <div style={{
        ...card, background: '#1e1b4b', border: '1px solid #4338ca',
      }}>
        <div style={sectionTitle}>
          <span>📡</span> IP Allowlist Reminder
        </div>
        <p style={{ color: '#a5b4fc', fontSize: '14px', lineHeight: '1.6', margin: 0 }}>
          When creating API keys on each exchange, add your server's IP to the allowlist.
          Your current IP: <strong style={{ color: '#e0e7ff' }}>122.167.42.6</strong>
          <br />
          <span style={{ color: '#818cf8', fontSize: '12px' }}>
            Note: If your ISP assigns dynamic IPs, you may need to update this periodically or use a VPS with a static IP.
          </span>
        </p>
      </div>

      {/* ── Trading Parameters ────────────────────── */}
      <h2 style={{ fontSize: '14px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '1px', marginTop: '32px', marginBottom: '12px' }}>
        Trading Parameters
      </h2>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={sectionTitle}>
            <span>⚙️</span> Risk & Capital
          </div>
          <Toggle
            on={trading.paper_mode}
            onChange={v => setTrading(p => ({ ...p, paper_mode: v }))}
            labelText={trading.paper_mode ? 'Paper Mode (Safe)' : 'LIVE Trading'}
          />
        </div>

        {!trading.paper_mode && (
          <div style={{
            padding: '10px 14px', borderRadius: '6px', marginBottom: '16px',
            background: '#7f1d1d', border: '1px solid #dc2626',
            fontSize: '13px', color: '#fca5a5', fontWeight: 600,
          }}>
            ⚠ LIVE TRADING MODE — Real money will be used. Proceed with caution.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
          <InputField
            labelText="Initial Capital (USDT)"
            value={trading.initial_capital}
            onChange={v => setTrading(p => ({ ...p, initial_capital: parseFloat(v) || 0 }))}
            type="number"
          />
          <InputField
            labelText="Max Leverage"
            value={trading.max_leverage}
            onChange={v => setTrading(p => ({ ...p, max_leverage: parseFloat(v) || 1 }))}
            type="number"
          />
          <InputField
            labelText="Daily Drawdown Limit"
            value={trading.daily_drawdown_limit}
            onChange={v => setTrading(p => ({ ...p, daily_drawdown_limit: parseFloat(v) || 0 }))}
            type="number"
            placeholder="0.03 = 3%"
          />
          <InputField
            labelText="Portfolio Heat Limit"
            value={trading.portfolio_heat_limit}
            onChange={v => setTrading(p => ({ ...p, portfolio_heat_limit: parseFloat(v) || 0 }))}
            type="number"
            placeholder="0.30 = 30%"
          />
          <InputField
            labelText="Kelly Fraction"
            value={trading.kelly_fraction}
            onChange={v => setTrading(p => ({ ...p, kelly_fraction: parseFloat(v) || 0 }))}
            type="number"
            placeholder="0.5 = Half-Kelly"
          />
          <InputField
            labelText="Per-Asset Limit"
            value={trading.per_asset_limit}
            onChange={v => setTrading(p => ({ ...p, per_asset_limit: parseFloat(v) || 0 }))}
            type="number"
            placeholder="0.15 = 15%"
          />
        </div>

        <button style={{ ...btnPrimary, marginTop: '12px' }} onClick={saveTradingParams} disabled={saving}>
          {saving ? 'Saving...' : 'Save Trading Parameters'}
        </button>
      </div>

      {/* ── Alert / Notification Settings ─────────── */}
      <h2 style={{ fontSize: '14px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '1px', marginTop: '32px', marginBottom: '12px' }}>
        Alerts & Notifications
      </h2>

      <div style={card}>
        <div style={sectionTitle}><span>📱</span> Telegram</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
          <InputField
            labelText="Bot Token"
            value={alerts.telegram_bot_token}
            onChange={v => setAlerts(p => ({ ...p, telegram_bot_token: v }))}
            placeholder="123456:ABC-DEF..."
            type="password"
          />
          <InputField
            labelText="Chat ID"
            value={alerts.telegram_chat_id}
            onChange={v => setAlerts(p => ({ ...p, telegram_chat_id: v }))}
            placeholder="-100123456789"
          />
        </div>

        <div style={{ ...sectionTitle, marginTop: '20px' }}><span>📧</span> Email (SMTP)</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
          <InputField
            labelText="SMTP Host"
            value={alerts.smtp_host}
            onChange={v => setAlerts(p => ({ ...p, smtp_host: v }))}
            placeholder="smtp.gmail.com"
          />
          <InputField
            labelText="SMTP Port"
            value={alerts.smtp_port}
            onChange={v => setAlerts(p => ({ ...p, smtp_port: parseInt(v) || 587 }))}
            type="number"
          />
          <InputField
            labelText="SMTP User"
            value={alerts.smtp_user}
            onChange={v => setAlerts(p => ({ ...p, smtp_user: v }))}
            placeholder="you@gmail.com"
          />
          <InputField
            labelText="SMTP Password"
            value={alerts.smtp_pass}
            onChange={v => setAlerts(p => ({ ...p, smtp_pass: v }))}
            type="password"
            placeholder="App-specific password"
          />
          <InputField
            labelText="Alert Email"
            value={alerts.alert_email}
            onChange={v => setAlerts(p => ({ ...p, alert_email: v }))}
            placeholder="alerts@yourdomain.com"
          />
        </div>

        <button style={{ ...btnPrimary, marginTop: '12px' }} onClick={saveAlerts} disabled={saving}>
          {saving ? 'Saving...' : 'Save Alert Settings'}
        </button>
      </div>

      {/* ── Restart Reminder ──────────────────────── */}
      <div style={{
        ...card, background: '#1c1917', border: '1px solid #78350f', marginTop: '16px',
      }}>
        <div style={{ fontSize: '13px', color: '#fbbf24', lineHeight: '1.6' }}>
          <strong>Note:</strong> After saving new API keys, restart the bot services for changes to take effect:
          <code style={{
            display: 'block', marginTop: '8px', padding: '10px',
            background: '#0d1117', borderRadius: '6px', color: '#a5b4fc',
            fontFamily: 'JetBrains Mono, monospace', fontSize: '13px',
          }}>
            docker-compose restart data_ingestion execution_engine latency_monitor
          </code>
        </div>
      </div>

      {/* Bottom spacer */}
      <div style={{ height: '40px' }} />
    </div>
  );
}
