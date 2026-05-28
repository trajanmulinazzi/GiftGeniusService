import React, { useState } from 'react';
import { api } from '../api.js';
import { UserCircle, ChevronRight, DollarSign } from 'lucide-react';

export default function ProfilePanel({ hobbies, users, profiles, onRefresh, onToast, onNext }) {
  const [userId, setUserId] = useState('');
  const [label, setLabel] = useState('Mom');
  const [selectedHobbies, setSelectedHobbies] = useState(new Set());
  const [budgetMin, setBudgetMin] = useState(25);
  const [budgetMax, setBudgetMax] = useState(100);
  const [creating, setCreating] = useState(false);

  function toggleHobby(id) {
    setSelectedHobbies(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function createProfile() {
    const uid = userId || users[0]?.id;
    if (!uid) { onToast('Create a user first', 'error'); return; }
    if (selectedHobbies.size === 0) { onToast('Select at least one hobby', 'error'); return; }

    setCreating(true);
    try {
      await api('POST', '/profiles', {
        user_id: uid,
        label,
        hobby_ids: [...selectedHobbies],
        budget_min: budgetMin,
        budget_max: budgetMax,
      });
      onToast('Profile created');
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
          <UserCircle size={18} />
          <h2>Create Profile</h2>
        </div>
        <p className="card-desc">A profile represents a gift recipient with hobbies and budget.</p>

        <div className="field">
          <label>User</label>
          <select value={userId} onChange={e => setUserId(e.target.value)}>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>

        <div className="field">
          <label>Recipient Label</label>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Mom, Dad, Partner..." />
        </div>

        <div className="field">
          <label>Hobbies</label>
          <div className="hobby-picker">
            {hobbies.map(h => (
              <button
                key={h.id}
                className={`hobby-chip ${selectedHobbies.has(h.id) ? 'selected' : ''}`}
                onClick={() => toggleHobby(h.id)}
              >
                {h.name}
              </button>
            ))}
          </div>
        </div>

        <div className="form-row">
          <div className="field">
            <label><DollarSign size={12} /> Budget Min</label>
            <input type="number" value={budgetMin} onChange={e => setBudgetMin(+e.target.value)} />
          </div>
          <div className="field">
            <label><DollarSign size={12} /> Budget Max</label>
            <input type="number" value={budgetMax} onChange={e => setBudgetMax(+e.target.value)} />
          </div>
        </div>

        <button className="btn btn-primary" onClick={createProfile} disabled={creating}>
          {creating ? 'Creating...' : 'Create Profile'}
        </button>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Existing Profiles</h2>
        </div>
        {profiles.length === 0 ? (
          <p className="card-desc">No profiles yet.</p>
        ) : (
          <div className="entity-list">
            {profiles.map(p => (
              <div key={p.id} className="profile-card">
                <div className="profile-top">
                  <span className="profile-label">{p.label}</span>
                  <span className="entity-id">{p.id.slice(0, 8)}</span>
                </div>
                <div className="profile-budget">${p.budget_min} &ndash; ${p.budget_max}</div>
                <div className="profile-hobbies">
                  {(p.hobby_ids ?? []).length} hobbies
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card card-full">
        <button className="btn btn-accent btn-next" onClick={onNext}>
          Continue to Session <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
