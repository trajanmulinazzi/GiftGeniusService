import React, { useState, useEffect, useCallback } from 'react';
import { api } from './api.js';
import SetupPanel from './panels/SetupPanel.jsx';
import PrecomputePanel from './panels/PrecomputePanel.jsx';
import ProfilePanel from './panels/ProfilePanel.jsx';
import SessionPanel from './panels/SessionPanel.jsx';
import FeedPanel from './panels/FeedPanel.jsx';
import StatsBar from './panels/StatsBar.jsx';
import Toast from './components/Toast.jsx';
import './styles.css';

export default function App() {
  const [hobbies, setHobbies] = useState([]);
  const [users, setUsers] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [stats, setStats] = useState(null);
  const [toast, setToast] = useState(null);
  const [activeStep, setActiveStep] = useState(0);

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [h, u, s] = await Promise.all([
        api('GET', '/admin/hobbies'),
        api('GET', '/admin/users'),
        api('GET', '/admin/stats'),
      ]);
      setHobbies(h.data ?? h);
      setUsers(u.data ?? u);
      setStats(s);
      const [p, sess] = await Promise.all([
        api('GET', '/admin/profiles'),
        api('GET', '/admin/sessions'),
      ]);
      setProfiles(p.data ?? p);
      setSessions(sess.data ?? sess);
    } catch (err) {
      showToast('Server not reachable', 'error');
    }
  }, [showToast]);

  useEffect(() => { refresh(); }, [refresh]);

  const steps = [
    { label: 'Setup', num: 1 },
    { label: 'Pre-Compute', num: 2 },
    { label: 'Profile', num: 3 },
    { label: 'Session', num: 4 },
    { label: 'Feed', num: 5 },
  ];

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <div className="logo">
            <span className="logo-icon">G</span>
            <div>
              <h1>GiftGenius</h1>
              <span className="subtitle">Engine Test Console</span>
            </div>
          </div>
        </div>
        <StatsBar stats={stats} />
      </header>

      <nav className="step-nav">
        {steps.map((s, i) => (
          <button
            key={i}
            className={`step-btn ${activeStep === i ? 'active' : ''} ${i < activeStep ? 'done' : ''}`}
            onClick={() => setActiveStep(i)}
          >
            <span className="step-num">{s.num}</span>
            <span className="step-label">{s.label}</span>
          </button>
        ))}
      </nav>

      <main className="app-main">
        {activeStep === 0 && (
          <SetupPanel
            hobbies={hobbies}
            users={users}
            onRefresh={refresh}
            onToast={showToast}
            onNext={() => setActiveStep(1)}
          />
        )}
        {activeStep === 1 && (
          <PrecomputePanel
            stats={stats}
            onRefresh={refresh}
            onToast={showToast}
            onNext={() => setActiveStep(2)}
          />
        )}
        {activeStep === 2 && (
          <ProfilePanel
            hobbies={hobbies}
            users={users}
            profiles={profiles}
            onRefresh={refresh}
            onToast={showToast}
            onNext={() => setActiveStep(3)}
          />
        )}
        {activeStep === 3 && (
          <SessionPanel
            profiles={profiles}
            sessions={sessions}
            onRefresh={refresh}
            onToast={showToast}
            onNext={() => setActiveStep(4)}
          />
        )}
        {activeStep === 4 && (
          <FeedPanel
            sessions={sessions}
            onToast={showToast}
          />
        )}
      </main>

      {toast && <Toast message={toast.msg} type={toast.type} />}
    </div>
  );
}
