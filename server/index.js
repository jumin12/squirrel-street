'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');

/** @type {Pool | null} */
let pool = null;

/** In-memory fallback when DATABASE_URL is unset (resets on restart). */
const mem = {
  leaderboard: new Map(),
  challenges: new Map(),
  /** @type {Map<string, { host_score: number|null, guest_score: number|null }>} */
  challengeLevels: new Map()
};

function levelKey(code, levelNum) {
  return `${code}:${levelNum}`;
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i += 1) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn('No DATABASE_URL: using in-memory store (data lost on restart).');
    return;
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leaderboard (
      player_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT 'Anon',
      high_score INTEGER NOT NULL DEFAULT 0,
      highest_level INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS challenges (
      code TEXT PRIMARY KEY,
      seed BIGINT NOT NULL,
      start_level INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS challenge_levels (
      challenge_code TEXT NOT NULL REFERENCES challenges(code) ON DELETE CASCADE,
      level_num INTEGER NOT NULL,
      host_score INTEGER,
      guest_score INTEGER,
      PRIMARY KEY (challenge_code, level_num)
    );
  `);
  console.log('PostgreSQL tables ready.');
}

async function leaderboardList(limit) {
  const lim = Math.min(100, Math.max(1, limit));
  if (pool) {
    const { rows } = await pool.query(
      `SELECT player_id, display_name, high_score, highest_level, updated_at
       FROM leaderboard ORDER BY high_score DESC, highest_level DESC LIMIT $1`,
      [lim]
    );
    return rows;
  }
  return Array.from(mem.leaderboard.values())
    .sort((a, b) => b.high_score - a.high_score || b.highest_level - a.highest_level)
    .slice(0, lim);
}

async function leaderboardUpsert(body) {
  const player_id = String(body.player_id || '').slice(0, 64);
  const display_name = String(body.display_name || 'Anon').slice(0, 24);
  const high_score = Math.max(0, Math.floor(Number(body.high_score) || 0));
  const highest_level = Math.max(1, Math.floor(Number(body.highest_level) || 1));
  if (!player_id) {
    const err = new Error('player_id required');
    err.status = 400;
    throw err;
  }

  if (pool) {
    await pool.query(
      `INSERT INTO leaderboard (player_id, display_name, high_score, highest_level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (player_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         high_score = GREATEST(leaderboard.high_score, EXCLUDED.high_score),
         highest_level = GREATEST(leaderboard.highest_level, EXCLUDED.highest_level),
         updated_at = NOW()`,
      [player_id, display_name, high_score, highest_level]
    );
    return { ok: true };
  }

  const prev = mem.leaderboard.get(player_id);
  const nextHigh = prev ? Math.max(high_score, prev.high_score) : high_score;
  const nextLevel = prev ? Math.max(highest_level, prev.highest_level) : highest_level;
  mem.leaderboard.set(player_id, {
    player_id,
    display_name,
    high_score: nextHigh,
    highest_level: nextLevel,
    updated_at: new Date().toISOString()
  });
  return { ok: true };
}

async function challengeCreate(body) {
  const start_level = Math.max(1, Math.floor(Number(body.start_level) || 1));
  let seed = Math.floor(Number(body.seed));
  if (!Number.isFinite(seed) || seed <= 0) {
    seed = (Math.random() * 0x7fffffff) | 0;
  }
  let code = generateCode();
  if (pool) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await pool.query(
          'INSERT INTO challenges (code, seed, start_level) VALUES ($1, $2, $3)',
          [code, seed, start_level]
        );
        return { code, seed, start_level };
      } catch (e) {
        if (e.code === '23505') code = generateCode();
        else throw e;
      }
    }
    throw new Error('Could not allocate challenge code');
  }
  while (mem.challenges.has(code)) code = generateCode();
  mem.challenges.set(code, { code, seed, start_level });
  return { code, seed, start_level };
}

async function challengeGet(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  if (pool) {
    const { rows } = await pool.query(
      'SELECT code, seed, start_level FROM challenges WHERE code = $1',
      [c]
    );
    return rows[0] || null;
  }
  return mem.challenges.get(c) || null;
}

async function challengeLevelUpsert(code, role, levelNum, score) {
  const c = String(code || '').trim().toUpperCase();
  const r = role === 'host' || role === 'guest' ? role : null;
  const lv = Math.floor(Number(levelNum));
  const sc = Math.max(0, Math.round(Number(score)));
  if (!c || !r || !Number.isFinite(lv) || lv < 1) {
    const err = new Error('Invalid code, role, level, or score');
    err.status = 400;
    throw err;
  }

  const exists = await challengeGet(c);
  if (!exists) {
    const err = new Error('Challenge not found');
    err.status = 404;
    throw err;
  }

  if (pool) {
    await pool.query(
      `INSERT INTO challenge_levels (challenge_code, level_num, host_score, guest_score)
       VALUES ($1, $2,
         CASE WHEN $4 = 'host' THEN $3 ELSE NULL END,
         CASE WHEN $4 = 'guest' THEN $3 ELSE NULL END
       )
       ON CONFLICT (challenge_code, level_num) DO UPDATE SET
         host_score = COALESCE(EXCLUDED.host_score, challenge_levels.host_score),
         guest_score = COALESCE(EXCLUDED.guest_score, challenge_levels.guest_score)`,
      [c, lv, sc, r]
    );
    const { rows } = await pool.query(
      'SELECT level_num, host_score, guest_score FROM challenge_levels WHERE challenge_code = $1 AND level_num = $2',
      [c, lv]
    );
    return rows[0] || { level_num: lv, host_score: null, guest_score: null };
  }

  const key = levelKey(c, lv);
  const row = mem.challengeLevels.get(key) || { host_score: null, guest_score: null };
  if (r === 'host') row.host_score = sc;
  else row.guest_score = sc;
  mem.challengeLevels.set(key, row);
  return { level_num: lv, host_score: row.host_score, guest_score: row.guest_score };
}

async function challengeLevelsList(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return [];
  if (pool) {
    const { rows } = await pool.query(
      `SELECT level_num, host_score, guest_score
       FROM challenge_levels WHERE challenge_code = $1 ORDER BY level_num ASC`,
      [c]
    );
    return rows;
  }
  return Array.from(mem.challengeLevels.entries())
    .filter(([k]) => k.startsWith(`${c}:`))
    .map(([k, v]) => ({
      level_num: Number(k.split(':')[1]),
      host_score: v.host_score,
      guest_score: v.guest_score
    }))
    .sort((a, b) => a.level_num - b.level_num);
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, store: pool ? 'postgres' : 'memory' });
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 40;
    const rows = await leaderboardList(limit);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'leaderboard_failed' });
  }
});

app.post('/api/leaderboard', async (req, res) => {
  try {
    await leaderboardUpsert(req.body || {});
    res.json({ ok: true });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: String(e.message) });
  }
});

app.post('/api/challenges', async (req, res) => {
  try {
    const row = await challengeCreate(req.body || {});
    res.json(row);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'challenge_create_failed' });
  }
});

app.get('/api/challenges/:code', async (req, res) => {
  try {
    const row = await challengeGet(req.params.code);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(row);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'challenge_get_failed' });
  }
});

app.post('/api/challenges/:code/level', async (req, res) => {
  try {
    const { role, level, score } = req.body || {};
    const row = await challengeLevelUpsert(req.params.code, role, level, score);
    res.json(row);
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: String(e.message) });
  }
});

app.get('/api/challenges/:code/levels', async (req, res) => {
  try {
    const levels = await challengeLevelsList(req.params.code);
    res.json({ levels });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'levels_failed' });
  }
});

app.use(express.static(ROOT));

async function main() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Squirrel Street server http://localhost:${PORT} (static + /api)`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});