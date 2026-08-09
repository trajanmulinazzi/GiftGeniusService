-- ============================================================================
-- GiftGenius — pg_cron for deployment Option A (standalone worker).
-- Run once via psql after the worker is deployed. Because the worker self-polls
-- the job queue, there is NO 10s dispatcher tick and NO Vault/http_post here —
-- these entries just ENQUEUE the nightly jobs, which the worker then runs.
--
--   psql "$DATABASE_URL" -f supabase/cron_setup_worker.sql
--
-- NOTE: cron schedules are in UTC on Supabase.
-- ============================================================================

select cron.schedule('nightly-yield-score', '0 2 * * *',
  $$ select enqueue_job('yield_score', '{}'::jsonb, 'nightly:yield_score', 5) $$);

select cron.schedule('nightly-taste-priors', '30 2 * * *',
  $$ select enqueue_job('taste_priors', '{}'::jsonb, 'nightly:taste_priors', 5) $$);

-- Housekeeping (§11). NB: VACUUM cannot run inside pg_cron's transaction, so we
-- ANALYZE here (transaction-safe, keeps planner stats fresh) and let Supabase
-- autovacuum reclaim space. Run a manual VACUUM out-of-band if you ever need it.
select cron.schedule('nightly-housekeeping', '0 3 * * *', $$
  delete from search_queries where fetched_at < now() - interval '60 days' and fetch_count = 1;
  delete from feed_candidates fc using feeds f
    where fc.feed_id = f.id
      and not exists (select 1 from interactions i where i.feed_id = f.id and i.created_at > now() - interval '30 days')
      and f.created_at < now() - interval '30 days';
  analyze products;
  analyze feed_candidates;
  analyze serve_log;
$$);

-- Verify:   select jobid, schedule, jobname, active from cron.job order by jobid;
-- Runs:     select jobname, status, start_time from cron.job_run_details order by start_time desc limit 10;
-- Remove:   select cron.unschedule('nightly-yield-score');
