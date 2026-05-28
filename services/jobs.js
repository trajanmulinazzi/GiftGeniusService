/**
 * Background Jobs (§11).
 * Scheduled via node-cron, started when the server boots.
 */

import cron from 'node-cron';
import { applyWeightDecay } from './signal.js';
import { refreshExpiringCache } from './amazon.js';

const jobs = [];

export function startJobs() {
  // Weight decay — daily at 03:00 UTC
  jobs.push(cron.schedule('0 3 * * *', async () => {
    console.log('[Jobs] Running weight decay...');
    try {
      const updated = await applyWeightDecay();
      console.log(`[Jobs] Weight decay complete: ${updated} weights updated`);
    } catch (err) {
      console.error('[Jobs] Weight decay failed:', err.message);
    }
  }, { timezone: 'UTC' }));

  // Cache refresh — every 6 hours at :30 past
  jobs.push(cron.schedule('30 */6 * * *', async () => {
    console.log('[Jobs] Running cache refresh...');
    try {
      const refreshed = await refreshExpiringCache();
      console.log(`[Jobs] Cache refresh complete: ${refreshed} entries refreshed`);
    } catch (err) {
      console.error('[Jobs] Cache refresh failed:', err.message);
    }
  }, { timezone: 'UTC' }));

  console.log('[Jobs] Background jobs scheduled: weight_decay (daily 03:00 UTC), cache_refresh (every 6h)');
}

export function stopJobs() {
  for (const job of jobs) job.stop();
  jobs.length = 0;
}
