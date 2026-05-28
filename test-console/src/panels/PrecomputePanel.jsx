import React, { useState } from 'react';
import { api } from '../api.js';
import { Cpu, ChevronRight, RefreshCw, Zap } from 'lucide-react';

export default function PrecomputePanel({ stats, onRefresh, onToast, onNext }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  async function runPrecompute() {
    setRunning(true);
    setResult(null);
    try {
      const data = await api('POST', '/admin/precompute');
      setResult(data);
      onToast('Pre-computation complete');
      await onRefresh();
    } catch (err) {
      onToast(err.error || 'Pre-computation failed', 'error');
    }
    setRunning(false);
  }

  async function refreshCache() {
    setRefreshing(true);
    try {
      const data = await api('POST', '/admin/cache/refresh');
      onToast(`Cache refreshed: ${data.refreshed} entries`);
      await onRefresh();
    } catch (err) {
      onToast(err.error || 'Cache refresh failed', 'error');
    }
    setRefreshing(false);
  }

  const statCards = stats ? [
    { label: 'Hobby Expansions', value: stats.hobby_angle_expansions ?? 0 },
    { label: 'Occasion Terms', value: stats.occasion_search_terms ?? 0 },
    { label: 'Amazon Cache', value: stats.amazon_cache_entries ?? 0 },
  ] : [];

  return (
    <div className="panel-grid">
      <div className="card card-full">
        <div className="card-header">
          <Cpu size={18} />
          <h2>Pre-Computation Pipeline</h2>
        </div>
        <p className="card-desc">
          Runs Claude to generate search terms for all hobby x angle and occasion x budget pairs.
          Required before feeds will work.
        </p>

        <div className="stat-cards">
          {statCards.map(s => (
            <div key={s.label} className="mini-stat">
              <div className="mini-stat-val">{s.value}</div>
              <div className="mini-stat-lbl">{s.label}</div>
            </div>
          ))}
        </div>

        <div className="btn-row">
          <button className="btn btn-warning" onClick={runPrecompute} disabled={running}>
            <Zap size={14} />
            {running ? 'Running Pipeline...' : 'Run Full Pipeline'}
          </button>
          <button className="btn btn-ghost" onClick={refreshCache} disabled={refreshing}>
            <RefreshCw size={14} />
            {refreshing ? 'Refreshing...' : 'Refresh Cache'}
          </button>
          <button className="btn btn-ghost" onClick={onRefresh}>
            <RefreshCw size={14} /> Reload Stats
          </button>
        </div>

        {running && (
          <div className="progress-bar">
            <div className="progress-bar-inner progress-indeterminate" />
          </div>
        )}

        {result && (
          <div className="log-box">
            <div>Hobbies: {result.hobbies.total} expansions ({result.hobbies.errors} errors)</div>
            <div>Occasions: {result.occasions.total} expansions ({result.occasions.errors} errors)</div>
          </div>
        )}
      </div>

      <div className="card card-full">
        <button className="btn btn-accent btn-next" onClick={onNext}>
          Continue to Profile <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
