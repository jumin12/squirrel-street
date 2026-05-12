import express from 'express';
import cors from 'cors';
import pg from 'pg';

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

async function migrate() {
  if (!pool) throw new Error('DATABASE_URL is not set');
  await pool.query(initSql);
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
    status: r.status
  };
}

async function resolveRound(client, row) {
  const hostScore = row.round_host_score != null ? Number(row.round_host_score) : null;
  const guestScore = row.round_guest_score != null ? Number(row.round_guest_score) : null;
  if (hostScore === null || guestScore === null) return;

  let summary = '';
  let hostWins = row.host_wins;
  let guestWins = row.guest_wins;
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
      updated_at = NOW()
     WHERE id = $5`,
    [hostWins, guestWins, lvl, summary, row.id]
  );
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
      `SELECT player_id, display_name, high_score, highest_level, updated_at
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
    const { player_id, display_name, high_score, highest_level } = req.body || {};
    if (!player_id || typeof player_id !== 'string') {
      return res.status(400).json({ error: 'player_id required' });
    }
    const name = (display_name || 'Player').toString().slice(0, 24);
    const score = Math.max(0, Math.floor(Number(high_score) || 0));
    const level = Math.max(1, Math.floor(Number(highest_level) || 1));

    const cur = await pool.query(
      'SELECT high_score, highest_level FROM leaderboard WHERE player_id = $1',
      [player_id]
    );
    const prev = cur.rows[0];
    const nextHigh = prev ? Math.max(score, Number(prev.high_score) || 0) : score;
    const nextLevel = prev ? Math.max(level, Number(prev.highest_level) || 0) : level;
    if (prev && nextHigh === Number(prev.high_score) && nextLevel === Number(prev.highest_level)) {
      return res.json({ ok: true, unchanged: true });
    }

    await pool.query(
      `INSERT INTO leaderboard (player_id, display_name, high_score, highest_level, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (player_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         high_score = EXCLUDED.high_score,
         highest_level = EXCLUDED.highest_level,
         updated_at = NOW()`,
      [player_id, name, nextHigh, nextLevel]
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
    const updated = rows2[0];

    if (updated.host_submitted_round && updated.guest_submitted_round) {
      await resolveRound(client, updated);
    }

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
