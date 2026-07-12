-- Incremental migration 002 — bulk penalize all angles when an interest is removed.
-- Apply with: node scripts/apply-sql.js db/migrations/002_suppress_hobby_interest.sql

CREATE OR REPLACE FUNCTION suppress_hobby_interest(
  p_profile_id UUID,
  p_hobby_id UUID,
  p_weight FLOAT,
  p_cooldown_days INT
) RETURNS VOID AS $$
  UPDATE profile_weights
  SET weight = p_weight,
      cooldown_until = now() + (p_cooldown_days || ' days')::interval,
      updated_at = now()
  WHERE profile_id = p_profile_id AND hobby_id = p_hobby_id;
$$ LANGUAGE sql;
