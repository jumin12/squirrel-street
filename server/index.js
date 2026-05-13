import express from 'express';
import cors from 'cors';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.join(__dirname, '..');

const { Pool } = pg;
const PORT = process.env.PORT || 8787;
const DATABASE_URL = process.env.DATABASE_URL;

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
    })
  : null;

const initSql = `
CREATE TABLE IF NOT EXISTS leaderboard (
  player_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT 'Player',
  high_score INT NOT NULL DEFAULT 0,
  highest_level INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  seed BIGINT NOT NULL,
  start_level INT NOT NULL,
  current_level INT NOT NULL,
  host_id TEXT NOT NULL,
  host_name TEXT,
  guest_id TEXT,
  guest_name TEXT,
  reserved_guest_id TEXT,
  host_wins INT NOT NULL DEFAULT 0,
  guest_wins INT NOT NULL DEFAULT 0,
  round_host_score INT,
  round_guest_score INT,
  host_submitted_round BOOLEAN NOT NULL DEFAULT FALSE,
  guest_submitted_round BOOLEAN NOT NULL DEFAULT FALSE,
  last_resolved_level INT NOT NULL DEFAULT 0,
  last_round_summary TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_challenges_code ON challenges(code);
`;

const migrateLeaderboardCols = [
  'ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS words_spelled INT NOT NULL DEFAULT 0',
  'ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS mp_wins INT NOT NULL DEFAULT 0',
  'ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS mp_losses INT NOT NULL DEFAULT 0',
  'ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS mp_total_score BIGINT NOT NULL DEFAULT 0',
  'ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS facebook_id TEXT'
];

const migrateChallengeCols = [
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS host_eliminated BOOLEAN NOT NULL DEFAULT FALSE',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS guest_eliminated BOOLEAN NOT NULL DEFAULT FALSE',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS host_total_points BIGINT NOT NULL DEFAULT 0',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS guest_total_points BIGINT NOT NULL DEFAULT 0',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS host_words_accum INT NOT NULL DEFAULT 0',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS guest_words_accum INT NOT NULL DEFAULT 0',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS winner_id TEXT',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS match_summary TEXT'
];

async function migrate() {
  if (!pool) throw new Error('DATABASE_URL is not set');
  await pool.query(initSql);
  for (const sql of migrateLeaderboardCols) {
    await pool.query(sql);
  }
  for (const sql of migrateChallengeCols) {
    await pool.query(sql);
  }
}

function rowToChallenge(r) {
  return {
    code: r.code,
    seed: Number(r.seed),
    start_level: r.start_level,
    current_level: r.current_level,
    host_id: r.host_id,
    host_name: r.host_name,
    guest_id: r.guest_id,
    guest_name: r.guest_name,
    reserved_guest_id: r.reserved_guest_id,
    host_wins: r.host_wins,
    guest_wins: r.guest_wins,
    round_host_score: r.round_host_score,
    round_guest_score: r.round_guest_score,
    host_submitted_round: r.host_submitted_round,
    guest_submitted_round: r.guest_submitted_round,
    last_resolved_level: r.last_resolved_level,
    last_round_summary: r.last_round_summary,
    status: r.status,
    host_eliminated: Boolean(r.host_eliminated),
    guest_eliminated: Boolean(r.guest_eliminated),
    host_total_points: r.host_total_points != null ? Number(r.host_total_points) : 0,
    guest_total_points: r.guest_total_points != null ? Number(r.guest_total_points) : 0,
    host_words_accum: r.host_words_accum != null ? Number(r.host_words_accum) : 0,
    guest_words_accum: r.guest_words_accum != null ? Number(r.guest_words_accum) : 0,
    winner_id: r.winner_id || null,
    match_summary: r.match_summary || null,
    created_at: r.created_at || null
  };
}

async function tryResolveRound(client, row) {
  let hostScore = row.round_host_score != null ? Number(row.round_host_score) : null;
  let guestScore = row.round_guest_score != null ? Number(row.round_guest_score) : null;
  if (hostScore === null && row.host_eliminated) hostScore = 0;
  if (guestScore === null && row.guest_eliminated) guestScore = 0;
  if (hostScore === null || guestScore === null) return false;

  let summary = '';
  let hostWins = Number(row.host_wins) || 0;
  let guestWins = Number(row.guest_wins) || 0;
  const lvl = row.current_level;

  if (hostScore > guestScore) {
    hostWins += 1;
    summary = `Level ${lvl}: Host wins (${hostScore} vs ${guestScore}).`;
  } else if (guestScore > hostScore) {
    guestWins += 1;
    summary = `Level ${lvl}: Guest wins (${guestScore} vs ${hostScore}).`;
  } else {
    summary = `Level ${lvl}: Tie at ${hostScore} pts.`;
  }

  const prevHt = Number(row.host_total_points) || 0;
  const prevGt = Number(row.guest_total_points) || 0;

  await client.query(
    `UPDATE challenges SET
      host_wins = $1,
      guest_wins = $2,
      last_resolved_level = $3,
      last_round_summary = $4,
      current_level = current_level + 1,
      round_host_score = NULL,
      round_guest_score = NULL,
      host_submitted_round = FALSE,
      guest_submitted_round = FALSE,
      host_total_points = $6,
      guest_total_points = $7,
      updated_at = NOW()
     WHERE id = $5`,
    [hostWins, guestWins, lvl, summary, row.id, prevHt + hostScore, prevGt + guestScore]
  );
  return true;
}

async function finalizeMatchIfNeeded(client, row) {
  if (row.status !== 'active') return null;
  if (!row.guest_id) return null;
  if (!row.host_eliminated || !row.guest_eliminated) return null;

  const hid = row.host_id;
  const gid = row.guest_id;
  const ht = Number(row.host_total_points) || 0;
  const gt = Number(row.guest_total_points) || 0;
  const hw = Number(row.host_words_accum) || 0;
  const gw = Number(row.guest_words_accum) || 0;

  let winnerId = null;
  if (ht > gt) winnerId = hid;
  else if (gt > ht) winnerId = gid;

  const hn = row.host_name || 'Host';
  const gn = row.guest_name || 'Guest';
  let summary = '';
  if (winnerId === hid) summary = `Match over — ${hn} wins (${ht} vs ${gt} pts, words ${hw} vs ${gw}).`;
  else if (winnerId === gid) summary = `Match over — ${gn} wins (${gt} vs ${ht} pts, words ${gw} vs ${hw}).`;
  else summary = `Match over — tie at ${ht} pts (words ${hw} vs ${gw}).`;

  await client.query(
    `UPDATE challenges SET status = 'completed', winner_id = $1, match_summary = $2, updated_at = NOW() WHERE id = $3`,
    [winnerId, summary, row.id]
  );

  async function touchPlayer(pid, wonInc, lostInc, pts, words) {
    await client.query(
      `INSERT INTO leaderboard (player_id, display_name, words_spelled, mp_wins, mp_losses, mp_total_score, updated_at)
       VALUES ($1, 'Player', $2, $3, $4, $5, NOW())
       ON CONFLICT (player_id) DO UPDATE SET
         mp_wins = leaderboard.mp_wins + $3,
         mp_losses = leaderboard.mp_losses + $4,
         mp_total_score = leaderboard.mp_total_score + $5,
         words_spelled = GREATEST(COALESCE(leaderboard.words_spelled, 0), $2),
         updated_at = NOW()`,
      [pid, Math.max(0, Math.floor(words || 0)), wonInc, lostInc, Math.max(0, Math.floor(pts || 0))]
    );
  }

  if (winnerId) {
    const loserId = winnerId === hid ? gid : hid;
    const winPts = winnerId === hid ? ht : gt;
    const losePts = winnerId === hid ? gt : ht;
    const winWords = winnerId === hid ? hw : gw;
    const loseWords = winnerId === hid ? gw : hw;
    await touchPlayer(winnerId, 1, 0, winPts, winWords);
    await touchPlayer(loserId, 0, 1, losePts, loseWords);
  } else {
    await touchPlayer(hid, 0, 0, ht, hw);
    await touchPlayer(gid, 0, 0, gt, gw);
  }

  return summary;
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: Boolean(pool) });
});

app.get('/api/leaderboard', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));
    const { rows } = await pool.query(
      `SELECT player_id, display_name, high_score, highest_level,
              words_spelled, mp_wins, mp_losses, mp_total_score, updated_at
       FROM leaderboard
       ORDER BY high_score DESC, highest_level DESC
       LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'leaderboard_failed' });
  }
});

app.post('/api/leaderboard', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { player_id, display_name, high_score, highest_level, words_spelled, facebook_id } = req.body || {};
    if (!player_id || typeof player_id !== 'string') {
      return res.status(400).json({ error: 'player_id required' });
    }
    const name = (display_name || 'Player').toString().slice(0, 24);
    const score = Math.max(0, Math.floor(Number(high_score) || 0));
    const level = Math.max(1, Math.floor(Number(highest_level) || 1));
    const words = Math.max(0, Math.floor(Number(words_spelled) || 0));
    const fb =
      facebook_id && typeof facebook_id === 'string' ? facebook_id.slice(0, 64) : null;

    const cur = await pool.query(
      'SELECT high_score, highest_level, words_spelled, facebook_id FROM leaderboard WHERE player_id = $1',
      [player_id]
    );
    const prev = cur.rows[0];
    const nextHigh = prev ? Math.max(score, Number(prev.high_score) || 0) : score;
    const nextLevel = prev ? Math.max(level, Number(prev.highest_level) || 0) : level;
    const nextWords = prev ? Math.max(words, Number(prev.words_spelled) || 0) : words;
    const prevFb = prev && prev.facebook_id ? String(prev.facebook_id) : null;
    const unchanged =
      prev &&
      nextHigh === Number(prev.high_score) &&
      nextLevel === Number(prev.highest_level) &&
      nextWords === Number(prev.words_spelled || 0) &&
      (!fb || fb === prevFb);
    if (unchanged) {
      return res.json({ ok: true, unchanged: true });
    }

    await pool.query(
      `INSERT INTO leaderboard (player_id, display_name, high_score, highest_level, words_spelled, facebook_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (player_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         high_score = EXCLUDED.high_score,
         highest_level = EXCLUDED.highest_level,
         words_spelled = GREATEST(COALESCE(leaderboard.words_spelled, 0), EXCLUDED.words_spelled),
         facebook_id = COALESCE(EXCLUDED.facebook_id, leaderboard.facebook_id),
         updated_at = NOW()`,
      [player_id, name, nextHigh, nextLevel, nextWords, fb]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'leaderboard_write_failed' });
  }
});

app.post('/api/challenges', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { host_id, host_name, start_level, reserved_guest_id, reserved_guest_name } = req.body || {};
    if (!host_id || typeof host_id !== 'string') {
      return res.status(400).json({ error: 'host_id required' });
    }
    const sl = Math.max(1, Math.floor(Number(start_level) || 1));
    const seed = ((Math.random() * 0x7fffffff) | 0) >>> 0;
    const id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    let code = randomCode();
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await pool.query(
          `INSERT INTO challenges (
            id, code, seed, start_level, current_level,
            host_id, host_name, reserved_guest_id,
            host_wins, guest_wins, status, updated_at
          ) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, 0, 0, 'active', NOW())`,
          [
            id,
            code,
            seed,
            sl,
            host_id,
            (host_name || 'Host').toString().slice(0, 24),
            reserved_guest_id && typeof reserved_guest_id === 'string' ? reserved_guest_id : null
          ]
        );
        return res.json({
          code,
          seed,
          start_level: sl,
          current_level: sl,
          reserved_guest_id: reserved_guest_id || null,
          reserved_guest_name: reserved_guest_name ? String(reserved_guest_name).slice(0, 24) : null
        });
      } catch (e) {
        if (e.code === '23505') code = randomCode();
        else throw e;
      }
    }
    res.status(500).json({ error: 'could_not_create_code' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'challenge_create_failed' });
  }
});

app.post('/api/challenges/join', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { code, guest_id, guest_name } = req.body || {};
    if (!code || !guest_id) return res.status(400).json({ error: 'code and guest_id required' });
    const c = code.trim().toUpperCase();
    const { rows } = await pool.query('SELECT * FROM challenges WHERE code = $1', [c]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.status !== 'active') return res.status(410).json({ error: 'challenge_inactive' });
    if (row.guest_id && row.guest_id !== guest_id) return res.status(403).json({ error: 'challenge_full' });
    if (row.reserved_guest_id && row.reserved_guest_id !== guest_id) {
      return res.status(403).json({ error: 'wrong_opponent' });
    }

    if (!row.guest_id) {
      await pool.query(
        `UPDATE challenges SET guest_id = $1, guest_name = $2, updated_at = NOW() WHERE code = $3`,
        [guest_id, (guest_name || 'Guest').toString().slice(0, 24), c]
      );
    }

    const r2 = await pool.query('SELECT * FROM challenges WHERE code = $1', [c]);
    res.json(rowToChallenge(r2.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'join_failed' });
  }
});

app.get('/api/challenges/:code', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const c = req.params.code.trim().toUpperCase();
    const { rows } = await pool.query('SELECT * FROM challenges WHERE code = $1', [c]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(rowToChallenge(row));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'fetch_failed' });
  }
});

app.post('/api/challenges/:code/round', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const client = await pool.connect();
  try {
    const c = req.params.code.trim().toUpperCase();
    const { player_id, level, level_score } = req.body || {};
    if (!player_id || level == null || level_score == null) {
      return res.status(400).json({ error: 'player_id, level, level_score required' });
    }
    const lvl = Math.floor(Number(level));
    const pts = Math.round(Number(level_score));

    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM challenges WHERE code = $1 FOR UPDATE', [c]);
    const row = rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }
    if (row.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'inactive' });
    }
    if (lvl !== row.current_level) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'level_mismatch',
        expected: row.current_level,
        got: lvl
      });
    }

    const isHost = row.host_id === player_id;
    const isGuest = row.guest_id === player_id;
    if (!isHost && !isGuest) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'not_in_challenge' });
    }
    if (isHost && row.host_eliminated) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'eliminated' });
    }
    if (isGuest && row.guest_eliminated) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'eliminated' });
    }
    if (isHost && row.host_submitted_round) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'already_submitted' });
    }
    if (isGuest && row.guest_submitted_round) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'already_submitted' });
    }

    if (isHost) {
      await client.query(
        `UPDATE challenges SET round_host_score = $1, host_submitted_round = TRUE, updated_at = NOW() WHERE id = $2`,
        [pts, row.id]
      );
    } else {
      await client.query(
        `UPDATE challenges SET round_guest_score = $1, guest_submitted_round = TRUE, updated_at = NOW() WHERE id = $2`,
        [pts, row.id]
      );
    }

    const { rows: rows2 } = await client.query('SELECT * FROM challenges WHERE id = $1', [row.id]);
    let cur = rows2[0];

    await tryResolveRound(client, cur);
    const { rows: rows3 } = await client.query('SELECT * FROM challenges WHERE id = $1 FOR UPDATE', [row.id]);
    cur = rows3[0];
    await finalizeMatchIfNeeded(client, cur);

    await client.query('COMMIT');
    const { rows: finalRows } = await pool.query('SELECT * FROM challenges WHERE code = $1', [c]);
    res.json(rowToChallenge(finalRows[0]));
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    console.error(e);
    res.status(500).json({ error: 'round_failed' });
  } finally {
    client.release();
  }
});

app.post('/api/challenges/:code/eliminate', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const client = await pool.connect();
  try {
    const c = req.params.code.trim().toUpperCase();
    const { player_id, level, level_score, words_spelled } = req.body || {};
    if (!player_id || level == null || level_score == null) {
      return res.status(400).json({ error: 'player_id, level, level_score required' });
    }
    const lvl = Math.floor(Number(level));
    const pts = Math.round(Number(level_score));
    const words = Math.max(0, Math.floor(Number(words_spelled) || 0));

    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM challenges WHERE code = $1 FOR UPDATE', [c]);
    const row = rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }
    if (row.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'inactive' });
    }

    const isHost = row.host_id === player_id;
    const isGuest = row.guest_id === player_id;
    if (!isHost && !isGuest) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'not_in_challenge' });
    }

    if (isHost && row.host_eliminated) {
      await client.query('COMMIT');
      const { rows: fr } = await pool.query('SELECT * FROM challenges WHERE code = $1', [c]);
      return res.json(rowToChallenge(fr[0]));
    }
    if (isGuest && row.guest_eliminated) {
      await client.query('COMMIT');
      const { rows: fr } = await pool.query('SELECT * FROM challenges WHERE code = $1', [c]);
      return res.json(rowToChallenge(fr[0]));
    }

    if (lvl !== row.current_level) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'level_mismatch',
        expected: row.current_level,
        got: lvl
      });
    }

    if (isHost) {
      await client.query(
        `UPDATE challenges SET
           host_eliminated = TRUE,
           host_words_accum = GREATEST(host_words_accum, $1),
           round_host_score = CASE WHEN host_submitted_round THEN round_host_score ELSE $2 END,
           host_submitted_round = TRUE,
           updated_at = NOW()
         WHERE id = $3`,
        [words, pts, row.id]
      );
    } else {
      await client.query(
        `UPDATE challenges SET
           guest_eliminated = TRUE,
           guest_words_accum = GREATEST(guest_words_accum, $1),
           round_guest_score = CASE WHEN guest_submitted_round THEN round_guest_score ELSE $2 END,
           guest_submitted_round = TRUE,
           updated_at = NOW()
         WHERE id = $3`,
        [words, pts, row.id]
      );
    }

    const { rows: rows2 } = await client.query('SELECT * FROM challenges WHERE id = $1', [row.id]);
    let cur = rows2[0];

    await tryResolveRound(client, cur);
    const { rows: rows3 } = await client.query('SELECT * FROM challenges WHERE id = $1 FOR UPDATE', [row.id]);
    cur = rows3[0];
    await finalizeMatchIfNeeded(client, cur);

    await client.query('COMMIT');
    const { rows: finalRows } = await pool.query('SELECT * FROM challenges WHERE code = $1', [c]);
    res.json(rowToChallenge(finalRows[0]));
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    console.error(e);
    res.status(500).json({ error: 'eliminate_failed' });
  } finally {
    client.release();
  }
});

app.use(express.static(staticRoot, { index: ['index.html'], maxAge: '1d', dotfiles: 'ignore' }));

if (process.argv.includes('--migrate-only')) {
  migrate()
    .then(() => {
      console.log('Migrations OK');
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
} else {
  (async () => {
    if (!pool) {
      console.warn('DATABASE_URL missing — API will return 503 for data routes');
    } else {
      await migrate();
      console.log('Database ready');
    }
    app.listen(PORT, () => console.log(`squirrel-street-api listening on ${PORT}`));
  })();
}
