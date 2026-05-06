import { getDb, persistDb } from "../db/index.js";

/**
 * Catalog model - shared product inventory
 */

/**
 * Convert price to cents. Accepts dollars (24.99) or pre-calculated cents (2499).
 */
function toPriceCents(product) {
  if (product.price_cents != null) return product.price_cents;
  if (product.price != null) return Math.round(Number(product.price) * 100);
  return null;
}

export async function upsertProduct(product) {
  const pool = await getDb();
  const { source_id, source, title, image_url, buy_url, tags, rating, reviews_count, active } = product;
  const priceCents = toPriceCents(product);
  const currency = product.currency ?? "USD";
  const tagsJson = typeof tags === "string" ? tags : JSON.stringify(tags || []);

  const result = await pool.query(
    `INSERT INTO catalog (source_id, source, title, image_url, price_cents, currency, buy_url, tags, rating, reviews_count, active, last_refreshed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT(source, source_id) DO UPDATE SET
       title = excluded.title,
       image_url = excluded.image_url,
       price_cents = excluded.price_cents,
       currency = excluded.currency,
       buy_url = excluded.buy_url,
       tags = excluded.tags,
       rating = excluded.rating,
       reviews_count = excluded.reviews_count,
       active = excluded.active,
       last_refreshed = now()
     RETURNING id`,
    [
      source_id,
      source || "unknown",
      title,
      image_url || null,
      priceCents,
      currency,
      buy_url || null,
      tagsJson,
      rating != null ? Number(rating) : null,
      reviews_count != null ? Math.floor(Number(reviews_count)) : null,
      active !== undefined ? (active ? 1 : 0) : 1,
    ]
  );
  persistDb();
  return result.rows[0]?.id ?? null;
}

/**
 * @param {number|null} budgetMin - min budget in dollars (e.g. 30)
 * @param {number|null} budgetMax - max budget in dollars (e.g. 80)
 */
export async function getActiveProducts(budgetMin = null, budgetMax = null) {
  const pool = await getDb();
  let sql = "SELECT * FROM catalog WHERE active = 1";
  const params = [];
  let paramIndex = 1;

  if (budgetMin != null) {
    const minCents = Math.round(budgetMin * 100);
    sql += ` AND (price_cents IS NULL OR price_cents >= $${paramIndex})`;
    params.push(minCents);
    paramIndex++;
  }
  if (budgetMax != null) {
    const maxCents = Math.round(budgetMax * 100);
    sql += ` AND (price_cents IS NULL OR price_cents <= $${paramIndex})`;
    params.push(maxCents);
  }

  const result = await pool.query(sql, params);
  return result.rows;
}

export async function getProductById(id) {
  const pool = await getDb();
  const result = await pool.query("SELECT * FROM catalog WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function getProductsByIds(ids) {
  if (!ids?.length) return [];
  const pool = await getDb();
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  const result = await pool.query(
    `SELECT * FROM catalog WHERE id IN (${placeholders})`,
    ids
  );
  return result.rows;
}

/**
 * Record that a catalog item was shown to a user.
 */
export async function recordShown(catalogItemId) {
  const pool = await getDb();
  await pool.query(
    `UPDATE catalog SET times_shown = times_shown + 1, last_shown_at = now() WHERE id = $1`,
    [catalogItemId]
  );
}

/**
 * Increment times_liked when a user likes/shops a catalog item.
 */
export async function incrementTimesLiked(catalogItemId) {
  const pool = await getDb();
  await pool.query(
    `UPDATE catalog SET times_liked = times_liked + 1 WHERE id = $1`,
    [catalogItemId]
  );
}

/**
 * Cache-first candidate query: find unseen catalog items matching any of the
 * given tags, within budget, excluding items already seen/queued for this feed.
 * @param {number} feedId
 * @param {string[]} tags - canonical tags to match (OR logic)
 * @param {{ budgetMinCents?: number, budgetMaxCents?: number, limit?: number }} opts
 * @returns {Promise<object[]>} catalog rows
 */
export async function getUnseenCandidates(feedId, tags, opts = {}) {
  if (!tags?.length) return [];
  const pool = await getDb();
  const limit = opts.limit ?? 20;
  const params = [tags, feedId];
  let idx = 3;

  let budgetClause = "";
  if (opts.budgetMinCents != null) {
    budgetClause += ` AND (c.price_cents IS NULL OR c.price_cents >= $${idx})`;
    params.push(opts.budgetMinCents);
    idx++;
  }
  if (opts.budgetMaxCents != null) {
    budgetClause += ` AND (c.price_cents IS NULL OR c.price_cents <= $${idx})`;
    params.push(opts.budgetMaxCents);
    idx++;
  }

  params.push(limit);

  const sql = `
    SELECT c.* FROM catalog c
    WHERE c.active = 1
      AND c.tags::jsonb ?| $1
      AND c.id NOT IN (
        SELECT catalog_item_id FROM interactions WHERE feed_id = $2
        UNION
        SELECT catalog_item_id FROM seen_items WHERE feed_id = $2
        UNION
        SELECT catalog_item_id FROM queue_items WHERE feed_id = $2
      )
      ${budgetClause}
    ORDER BY c.last_refreshed DESC NULLS LAST
    LIMIT $${idx}
  `;
  const result = await pool.query(sql, params);
  return result.rows;
}
