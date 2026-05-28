import React, { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence, useMotionValue, useTransform } from 'framer-motion';
import { api } from '../api.js';
import { Loader2, Heart, X, ShoppingBag, ThumbsDown, RotateCcw, Smartphone } from 'lucide-react';

export default function FeedPanel({ sessions, onToast }) {
  const [sessionId, setSessionId] = useState('');
  const [items, setItems] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [signals, setSignals] = useState({});
  const [view, setView] = useState('phone');

  async function loadFeed() {
    const sid = sessionId || sessions[0]?.id;
    if (!sid) { onToast('Start a session first', 'error'); return; }
    setLoading(true);
    setCurrentIdx(0);
    setSignals({});
    try {
      const data = await api('GET', `/feed/${sid}?batch=10`);
      setItems(data.items);
      if (data.items.length === 0) onToast('No items returned', 'error');
    } catch (err) {
      onToast(err.error || 'Failed to load feed', 'error');
    }
    setLoading(false);
  }

  async function sendSignal(eventId, signal) {
    if (!eventId || signals[eventId]) return;
    setSignals(prev => ({ ...prev, [eventId]: signal }));
    try {
      await api('POST', '/feed/signal', { feed_event_id: eventId, signal });
    } catch {
      // fire and forget
    }
    setTimeout(() => setCurrentIdx(i => i + 1), 300);
  }

  const current = items[currentIdx];
  const upcoming = items.slice(currentIdx + 1, currentIdx + 3);

  return (
    <div className="feed-panel">
      <div className="feed-controls">
        <div className="field" style={{ flex: 1 }}>
          <label>Session</label>
          <select value={sessionId} onChange={e => setSessionId(e.target.value)}>
            {sessions.map(s => (
              <option key={s.id} value={s.id}>{s.id.slice(0, 8)} — {s.occasion}</option>
            ))}
          </select>
        </div>
        <button className="btn btn-primary" onClick={loadFeed} disabled={loading} style={{ marginTop: 22 }}>
          {loading ? <><Loader2 size={14} className="spin" /> Loading...</> : 'Load Feed'}
        </button>
        <div className="view-toggle" style={{ marginTop: 22 }}>
          <button
            className={`toggle-btn ${view === 'phone' ? 'active' : ''}`}
            onClick={() => setView('phone')}
            title="Phone preview"
          >
            <Smartphone size={16} />
          </button>
          <button
            className={`toggle-btn ${view === 'grid' ? 'active' : ''}`}
            onClick={() => setView('grid')}
            title="Grid view"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/><rect x="10" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/><rect x="1" y="10" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/><rect x="10" y="10" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/></svg>
          </button>
        </div>
      </div>

      {items.length === 0 && !loading && (
        <div className="feed-empty">
          <ShoppingBag size={48} strokeWidth={1} />
          <p>Load a feed to preview items</p>
        </div>
      )}

      {view === 'phone' && items.length > 0 && (
        <div className="phone-container">
          <div className="phone-frame">
            <div className="phone-notch" />
            <div className="phone-screen">
              <div className="phone-header">
                <span className="phone-title">GiftGenius</span>
                <span className="phone-counter">{currentIdx + 1} / {items.length}</span>
              </div>

              <div className="card-stack">
                <AnimatePresence mode="popLayout">
                  {current && (
                    <SwipeCard
                      key={current.asin + currentIdx}
                      item={current}
                      onSignal={(signal) => sendSignal(current.feed_event_id, signal)}
                      signaled={signals[current.feed_event_id]}
                    />
                  )}
                </AnimatePresence>

                {!current && (
                  <div className="stack-empty">
                    <RotateCcw size={32} strokeWidth={1.5} />
                    <p>All items reviewed</p>
                    <button className="btn btn-primary" onClick={loadFeed}>Load More</button>
                  </div>
                )}
              </div>

              {current && (
                <div className="phone-actions">
                  <button className="action-btn action-dislike" onClick={() => sendSignal(current.feed_event_id, 'dislike')}>
                    <ThumbsDown size={20} />
                  </button>
                  <button className="action-btn action-skip" onClick={() => sendSignal(current.feed_event_id, 'skip')}>
                    <X size={24} />
                  </button>
                  <button className="action-btn action-save" onClick={() => sendSignal(current.feed_event_id, 'save')}>
                    <Heart size={20} />
                  </button>
                  <button className="action-btn action-shop" onClick={() => { window.open(current.product_url, '_blank'); sendSignal(current.feed_event_id, 'shop_now'); }}>
                    <ShoppingBag size={20} />
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="phone-sidebar">
            <h3>Item Details</h3>
            {current ? (
              <div className="detail-card">
                <div className="detail-row"><span className="detail-label">ASIN</span><span className="detail-val mono">{current.asin}</span></div>
                <div className="detail-row"><span className="detail-label">Price</span><span className="detail-val price">{current.price > 0 ? `$${current.price.toFixed(2)}` : 'N/A'}</span></div>
                <div className="detail-row"><span className="detail-label">Score</span><span className="detail-val">{(current.score ?? 0).toFixed(3)}</span></div>
                <div className="detail-row"><span className="detail-label">Slot</span><span className={`slot-badge slot-${current.slot_type}`}>{current.slot_type}</span></div>
                {current.angle && <div className="detail-row"><span className="detail-label">Angle</span><span className="detail-val">{current.angle}</span></div>}
                <div className="detail-row"><span className="detail-label">Event ID</span><span className="detail-val mono">{(current.feed_event_id ?? '').slice(0, 8)}</span></div>
              </div>
            ) : (
              <p className="card-desc">No item selected</p>
            )}

            <h3 style={{ marginTop: 20 }}>Up Next</h3>
            <div className="upcoming-list">
              {upcoming.map((item, i) => (
                <div key={item.asin} className="upcoming-item">
                  <img src={item.image_url || ''} alt="" />
                  <div>
                    <div className="upcoming-title">{item.title?.slice(0, 50)}</div>
                    <span className={`slot-badge slot-${item.slot_type}`}>{item.slot_type}</span>
                  </div>
                </div>
              ))}
              {upcoming.length === 0 && <p className="card-desc">No more items</p>}
            </div>

            <h3 style={{ marginTop: 20 }}>Signal Log</h3>
            <div className="signal-log">
              {Object.entries(signals).map(([id, sig]) => (
                <div key={id} className={`signal-entry signal-${sig}`}>
                  <span className="mono">{id.slice(0, 8)}</span>
                  <span className={`signal-badge signal-${sig}`}>{sig}</span>
                </div>
              ))}
              {Object.keys(signals).length === 0 && <p className="card-desc">No signals yet</p>}
            </div>
          </div>
        </div>
      )}

      {view === 'grid' && items.length > 0 && (
        <div className="feed-grid">
          {items.map(item => {
            const sig = signals[item.feed_event_id];
            return (
              <div key={item.asin} className={`grid-item ${sig ? 'grid-item-done' : ''}`}>
                <div className="grid-img-wrap">
                  <img src={item.image_url || ''} alt={item.title} />
                  <span className={`slot-badge slot-${item.slot_type}`}>{item.slot_type}</span>
                  {sig && <span className={`signal-overlay signal-${sig}`}>{sig}</span>}
                </div>
                <div className="grid-info">
                  <div className="grid-title">{item.title}</div>
                  <div className="grid-meta">
                    <span className="grid-price">{item.price > 0 ? `$${item.price.toFixed(2)}` : 'N/A'}</span>
                    <span className="grid-score">score: {(item.score ?? 0).toFixed(2)}</span>
                  </div>
                  {!sig && (
                    <div className="grid-actions">
                      <button className="btn btn-sm btn-ghost" onClick={() => sendSignal(item.feed_event_id, 'skip')}>Skip</button>
                      <button className="btn btn-sm btn-save" onClick={() => sendSignal(item.feed_event_id, 'save')}>Save</button>
                      <button className="btn btn-sm btn-shop" onClick={() => { window.open(item.product_url, '_blank'); sendSignal(item.feed_event_id, 'shop_now'); }}>Shop</button>
                      <button className="btn btn-sm btn-dislike" onClick={() => sendSignal(item.feed_event_id, 'dislike')}>Dislike</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SwipeCard({ item, onSignal, signaled }) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-200, 200], [-15, 15]);
  const opacity = useTransform(x, [-200, -100, 0, 100, 200], [0.5, 1, 1, 1, 0.5]);
  const saveIndicator = useTransform(x, [0, 100], [0, 1]);
  const skipIndicator = useTransform(x, [-100, 0], [1, 0]);

  function handleDragEnd(_, info) {
    if (info.offset.x > 100) onSignal('save');
    else if (info.offset.x < -100) onSignal('skip');
  }

  return (
    <motion.div
      className="swipe-card"
      style={{ x, rotate, opacity }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.8}
      onDragEnd={handleDragEnd}
      initial={{ scale: 0.95, opacity: 0, y: 20 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
    >
      <motion.div className="swipe-indicator swipe-save" style={{ opacity: saveIndicator }}>
        <Heart size={32} />
        SAVE
      </motion.div>
      <motion.div className="swipe-indicator swipe-skip" style={{ opacity: skipIndicator }}>
        <X size={32} />
        SKIP
      </motion.div>

      <div className="swipe-img-wrap">
        <img src={item.image_url || ''} alt={item.title} draggable={false} />
      </div>
      <div className="swipe-info">
        <div className="swipe-title">{item.title}</div>
        <div className="swipe-price">{item.price > 0 ? `$${item.price.toFixed(2)}` : 'Price N/A'}</div>
        <div className="swipe-badges">
          <span className={`slot-badge slot-${item.slot_type}`}>{item.slot_type}</span>
          {item.angle && <span className="slot-badge slot-angle">{item.angle}</span>}
        </div>
      </div>
    </motion.div>
  );
}
