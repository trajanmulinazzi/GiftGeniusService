import React, { useState } from 'react';
import { api, setToken, getToken } from '../api.js';
import { RefreshCw, Upload, UserPlus, ChevronRight, LogIn } from 'lucide-react';

export default function SetupPanel({ hobbies, users, onRefresh, onToast, onNext }) {
  const [syncing, setSyncing] = useState(false);
  const [syncLog, setSyncLog] = useState(null);
  const [userName, setUserName] = useState('Test User');
  const [userEmail, setUserEmail] = useState('test@example.com');
  const [creatingUser, setCreatingUser] = useState(false);

  async function syncTaxonomy() {
    setSyncing(true);
    try {
      const data = await api('POST', '/admin/taxonomy/sync');
      setSyncLog(data);
      onToast('Taxonomy synced');
      await onRefresh();
    } catch (err) {
      onToast(err.error || 'Sync failed', 'error');
    }
    setSyncing(false);
  }

  async function createUser() {
    if (!userName || !userEmail) return;
    setCreatingUser(true);
    try {
      await api('POST', '/admin/users', { name: userName, email: userEmail });
      onToast('User created');
      await onRefresh();
    } catch (err) {
      onToast(err.error || 'Failed to create user', 'error');
    }
    setCreatingUser(false);
  }

  async function loginAs(userId) {
    try {
      const { token } = await api('POST', '/auth/token', { user_id: userId });
      setToken(token);
      onToast('Authenticated');
    } catch (err) {
      onToast(err.message || err.error || 'Auth failed', 'error');
    }
  }

  return (
    <div className="panel-grid">
      <div className="card">
        <div className="card-header">
          <Upload size={18} />
          <h2>Taxonomy</h2>
        </div>
        <p className="card-desc">
          Sync hobbies, angles, and occasions from <code>taxonomy/*.txt</code> into Supabase.
        </p>
        <div className="btn-row">
          <button className="btn btn-primary" onClick={syncTaxonomy} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync Taxonomy'}
          </button>
          <button className="btn btn-ghost" onClick={onRefresh}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
        {syncLog && (
          <div className="log-box">
            <div>Hobbies: {syncLog.hobbies.inserted} new, {syncLog.hobbies.total} total</div>
            <div>Angles: {syncLog.angles} | Buckets: {syncLog.budget_buckets} | Occasions: {syncLog.occasions}</div>
          </div>
        )}
        {hobbies.length > 0 && (
          <div className="tag-cloud">
            {hobbies.map(h => <span key={h.id} className="tag">{h.name}</span>)}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <UserPlus size={18} />
          <h2>Users</h2>
        </div>
        <p className="card-desc">Create a test user to attach profiles to.</p>
        <div className="form-row">
          <div className="field">
            <label>Name</label>
            <input value={userName} onChange={e => setUserName(e.target.value)} placeholder="Name" />
          </div>
          <div className="field">
            <label>Email</label>
            <input value={userEmail} onChange={e => setUserEmail(e.target.value)} placeholder="Email" />
          </div>
        </div>
        <button className="btn btn-primary" onClick={createUser} disabled={creatingUser}>
          {creatingUser ? 'Creating...' : 'Create User'}
        </button>
        {users.length > 0 && (
          <div className="entity-list">
            {users.map(u => (
              <div key={u.id} className="entity-row">
                <span className="entity-name">{u.name}</span>
                <span className="entity-id">{u.id.slice(0, 8)}</span>
                <button className="btn btn-sm btn-ghost" onClick={() => loginAs(u.id)}>
                  <LogIn size={12} /> {getToken() ? 'Switch' : 'Login'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card card-full">
        <button className="btn btn-accent btn-next" onClick={onNext}>
          Continue to Pre-Compute <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
