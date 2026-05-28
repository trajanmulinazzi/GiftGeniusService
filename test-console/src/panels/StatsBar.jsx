import React from 'react';
import { Database, Tag, ShoppingCart, Users, BarChart3 } from 'lucide-react';

const STAT_CONFIG = [
  { key: 'hobbies', label: 'Hobbies', icon: Tag },
  { key: 'hobby_angle_expansions', label: 'Expansions', icon: BarChart3 },
  { key: 'amazon_cache_entries', label: 'Cached', icon: ShoppingCart },
  { key: 'profiles', label: 'Profiles', icon: Users },
  { key: 'feed_events', label: 'Events', icon: Database },
];

export default function StatsBar({ stats }) {
  if (!stats) return null;
  return (
    <div className="stats-bar">
      {STAT_CONFIG.map(({ key, label, icon: Icon }) => (
        <div key={key} className="stat-pill">
          <Icon size={13} />
          <span className="stat-val">{stats[key] ?? 0}</span>
          <span className="stat-lbl">{label}</span>
        </div>
      ))}
    </div>
  );
}
