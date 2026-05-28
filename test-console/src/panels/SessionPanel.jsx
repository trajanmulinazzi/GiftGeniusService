import React, { useState } from 'react';
import { api } from '../api.js';
import { Play, ChevronRight } from 'lucide-react';

const OCCASIONS = [
  { value: 'birthday', label: 'Birthday' },
  { value: 'christmas', label: 'Christmas' },
  { value: 'mothers_day', label: "Mother's Day" },
  { value: 'fathers_day', label: "Father's Day" },
  { value: 'anniversary', label: 'Anniversary' },
  { value: 'graduation', label: 'Graduation' },
  { value: 'housewarming', label: 'Housewarming' },
  { value: 'just_because', label: 'Just Because' },
];

export default function SessionPanel({ profiles, sessions, onRefresh, onToast, onNext }) {
  const [profileId, setProfileId] = useState('');
  const [occasion, setOccasion] = useState('birthday');
  const [creating, setCreating] = useState(false);

  async function startSession() {
    const pid = profileId || profiles[0]?.id;
    if (!pid) { onToast('Create a profile first', 'error'); return; }

    setCreating(true);
    try {
      await api('POST', '/sessions', { profile_id: pid, occasion });
      onToast('Session started');
      await onRefresh();
    } catch (err) {
      onToast(err.error || 'Failed', 'error');
    }
    setCreating(false);
  }

  return (
    <div className="panel-grid">
      <div className="card">
        <div className="card-header">
          <Play size={18} />
          <h2>Start Session</h2>
        </div>
        <p className="card-desc">A session ties a profile to an occasion for feed generation.</p>

        <div className="field">
          <label>Profile</label>
          <select value={profileId} onChange={e => setProfileId(e.target.value)}>
            {profiles.map(p => (
              <option key={p.id} value={p.id}>{p.label} ({p.id.slice(0, 8)})</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Occasion</label>
          <div className="occasion-picker">
            {OCCASIONS.map(o => (
              <button
                key={o.value}
                className={`occasion-chip ${occasion === o.value ? 'selected' : ''}`}
                onClick={() => setOccasion(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <button className="btn btn-primary" onClick={startSession} disabled={creating}>
          {creating ? 'Starting...' : 'Start Session'}
        </button>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Active Sessions</h2>
        </div>
        {sessions.length === 0 ? (
          <p className="card-desc">No active sessions.</p>
        ) : (
          <div className="entity-list">
            {sessions.map(s => (
              <div key={s.id} className="session-row">
                <span className="session-occasion">{s.occasion}</span>
                <span className="entity-id">{s.id.slice(0, 8)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card card-full">
        <button className="btn btn-accent btn-next" onClick={onNext}>
          Continue to Feed <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
