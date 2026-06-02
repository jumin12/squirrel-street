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

CREATE TABLE IF NOT EXISTS challenge_rounds (
  challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  level INT NOT NULL,
  host_score INT,
  guest_score INT,
  host_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  guest_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  summary TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (challenge_id, level)
);

CREATE INDEX IF NOT EXISTS idx_challenge_rounds_challenge ON challenge_rounds(challenge_id, level);
`;

const migrateLeaderboardCols = [
  'ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS words_spelled INT NOT NULL DEFAULT 0',
  'ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS mp_wins INT NOT NULL DEFAULT 0',
  'ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS mp_losses INT NOT NULL DEFAULT 0',
  'ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS mp_total_score BIGINT NOT NULL DEFAULT 0',
  'ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS mp_words_spelled BIGINT NOT NULL DEFAULT 0',
  'ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS facebook_id TEXT'
];

const migrateFriendCols = [
  `CREATE TABLE IF NOT EXISTS friend_requests (
    id SERIAL PRIMARY KEY,
    from_player_id TEXT NOT NULL,
    to_player_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  'CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_player_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_player_id, status)'
];

const CHALLENGE_INACTIVITY_MS = 24 * 60 * 60 * 1000;

const migrateChallengeCols = [
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS host_eliminated BOOLEAN NOT NULL DEFAULT FALSE',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS guest_eliminated BOOLEAN NOT NULL DEFAULT FALSE',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS host_total_points BIGINT NOT NULL DEFAULT 0',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS guest_total_points BIGINT NOT NULL DEFAULT 0',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS host_words_accum INT NOT NULL DEFAULT 0',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS guest_words_accum INT NOT NULL DEFAULT 0',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS winner_id TEXT',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS match_summary TEXT',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS host_lives INT',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS guest_lives INT',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS host_eliminated_level INT',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS guest_eliminated_level INT',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS host_eliminated_lives INT',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS guest_eliminated_lives INT',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS last_rejoin_player_id TEXT',
  'ALTER TABLE challenges ADD COLUMN IF NOT EXISTS last_rejoin_at TIMESTAMPTZ'
];

const migrateChallengeRoundCols = [
  'ALTER TABLE challenge_rounds ADD COLUMN IF NOT EXISTS host_lives INT',
  'ALTER TABLE challenge_rounds ADD COLUMN IF NOT EXISTS guest_lives INT',
  'ALTER TABLE challenge_rounds ADD COLUMN IF NOT EXISTS host_words INT',
  'ALTER TABLE challenge_rounds ADD COLUMN IF NOT EXISTS guest_words INT'
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
  for (const sql of migrateChallengeRoundCols) {
    await pool.query(sql);
  }
  for (const sql of migrateFriendCols) {
    await pool.query(sql);
  }
}

async function expireInactiveChallenges(client) {
  const db = client || pool;
  if (!db) return;
  await db.query(
    `UPDATE challenges
     SET status = 'completed',
         match_summary = COALESCE(match_summary, 'Match closed after 24 hours of inactivity.'),
         updated_at = NOW()
     WHERE status = 'active'
       AND updated_at < NOW() - INTERVAL '24 hours'`
  );
}

async function areFriends(client, a, b) {
  const { rows } = await client.query(
    `SELECT 1 FROM friend_requests
     WHERE status = 'accepted'
       AND (
         (from_player_id = $1 AND to_player_id = $2)
         OR (from_player_id = $2 AND to_player_id = $1)
       )
     LIMIT 1`,
    [a, b]
  );
  return rows.length > 0;
}

function roundRowsToPayload(rounds = []) {
  return rounds.map((round) => ({
    level: round.level,
    host_score: round.host_score,
    guest_score: round.guest_score,
    host_submitted: Boolean(round.host_submitted),
    guest_submitted: Boolean(round.guest_submitted),
    resolved: Boolean(round.resolved),
    summary: round.summary || null,
    host_lives: round.host_lives != null ? Number(round.host_lives) : null,
    guest_lives: round.guest_lives != null ? Number(round.guest_lives) : null,
    host_words: round.host_words != null ? Number(round.host_words) : null,
    guest_words: round.guest_words != null ? Number(round.guest_words) : null
  }));
}

async function getRecentRounds(client, challengeId, limit = 12) {
  const { rows } = await client.query(
    `SELECT level, host_score, guest_score, host_submitted, guest_submitted, resolved, summary,
            host_lives, guest_lives, host_words, guest_words
     FROM challenge_rounds
     WHERE challenge_id = $1
     ORDER BY level DESC
     LIMIT $2`,
    [challengeId, limit]
  );
  return rows.reverse();
}

function rowToChallenge(r, rounds = []) {
  const payloadRounds = roundRowsToPayload(rounds);
  const latestRound = payloadRounds[payloadRounds.length - 1] || null;
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
    round_host_score: latestRound ? latestRound.host_score : r.round_host_score,
    round_guest_score: latestRound ? latestRound.guest_score : r.round_guest_score,
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
    created_at: r.created_at || null,
    host_lives: r.host_lives != null ? Number(r.host_lives) : null,
    guest_lives: r.guest_lives != null ? Number(r.guest_lives) : null,
    host_eliminated_level: r.host_eliminated_level != null ? Number(r.host_eliminated_level) : null,
    guest_eliminated_level: r.guest_eliminated_level != null ? Number(r.guest_eliminated_level) : null,
    host_eliminated_lives: r.host_eliminated_lives != null ? Number(r.host_eliminated_lives) : null,
    guest_eliminated_lives: r.guest_eliminated_lives != null ? Number(r.guest_eliminated_lives) : null,
    last_rejoin_player_id: r.last_rejoin_player_id || null,
    last_rejoin_at: r.last_rejoin_at || null,
    rounds: payloadRounds
  };
}

async function resolveStoredRounds(client, challengeId) {
  const { rows } = await client.query(
    `SELECT level, host_score, guest_score
     FROM challenge_rounds
     WHERE challenge_id = $1
       AND resolved = FALSE
       AND host_submitted = TRUE
       AND guest_submitted = TRUE
     ORDER BY level ASC`,
    [challengeId]
  );

  for (const round of rows) {
    const hostScore = Number(round.host_score) || 0;
    const guestScore = Number(round.guest_score) || 0;
    let hostInc = 0;
    let guestInc = 0;
    let summary = '';

    if (hostScore > guestScore) {
      hostInc = 1;
      summary = `Host wins level ${round.level} (${hostScore} vs ${guestScore}).`;
    } else if (guestScore > hostScore) {
      guestInc = 1;
      summary = `Guest wins level ${round.level} (${guestScore} vs ${hostScore}).`;
    } else {
      summary = `Level ${round.level} ties at ${hostScore} pts.`;
    }

    await client.query(
      `UPDATE challenge_rounds
       SET resolved = TRUE, summary = $3, updated_at = NOW()
       WHERE challenge_id = $1 AND level = $2`,
      [challengeId, round.level, summary]
    );
    await client.query(
      `UPDATE challenges
       SET host_wins = host_wins + $2,
           guest_wins = guest_wins + $3,
           last_resolved_level = GREATEST(last_resolved_level, $4),
           last_round_summary = $5,
           updated_at = NOW()
       WHERE id = $1`,
      [challengeId, hostInc, guestInc, round.level, summary]
    );
  }
}

async function submitChallengeScore(
  client,
  row,
  playerId,
  level,
  points,
  wordsSpelled = 0,
  eliminated = false,
  livesRemaining = null,
  wordsThisLevel = null
) {
  const isHost = row.host_id === playerId;
  const isGuest = row.guest_id === playerId;
  if (!isHost && !isGuest) {
    const err = new Error('not_in_challenge');
    err.status = 403;
    throw err;
  }
  if ((isHost && row.host_eliminated) || (isGuest && row.guest_eliminated)) {
    return false;
  }

  const lvl = Math.max(Number(row.start_level) || 1, Math.floor(Number(level) || row.start_level || 1));
  const pts = Math.max(0, Math.round(Number(points) || 0));
  const words = Math.max(0, Math.floor(Number(wordsSpelled) || 0));
  const lives =
    livesRemaining != null && Number.isFinite(Number(livesRemaining))
      ? Math.max(0, Math.floor(Number(livesRemaining)))
      : null;
  const wordsLv =
    wordsThisLevel != null && Number.isFinite(Number(wordsThisLevel))
      ? Math.max(0, Math.floor(Number(wordsThisLevel)))
      : null;

  await client.query(
    `INSERT INTO challenge_rounds (challenge_id, level, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (challenge_id, level) DO NOTHING`,
    [row.id, lvl]
  );

  const { rows } = await client.query(
    'SELECT * FROM challenge_rounds WHERE challenge_id = $1 AND level = $2 FOR UPDATE',
    [row.id, lvl]
  );
  const round = rows[0];
  const alreadySubmitted = isHost ? round.host_submitted : round.guest_submitted;

  if (!alreadySubmitted) {
    if (isHost) {
      await client.query(
        `UPDATE challenge_rounds
         SET host_score = $3, host_submitted = TRUE,
             host_lives = COALESCE($4, host_lives),
             host_words = COALESCE($5, host_words),
             updated_at = NOW()
         WHERE challenge_id = $1 AND level = $2`,
        [row.id, lvl, pts, lives, wordsLv]
      );
      await client.query(
        `UPDATE challenges SET
           host_total_points = host_total_points + $2,
           host_words_accum = GREATEST(host_words_accum, $3),
           current_level = GREATEST(current_level, $4),
           round_host_score = $2,
           host_submitted_round = TRUE,
           host_lives = COALESCE($6, host_lives),
           host_eliminated = CASE WHEN $5 THEN TRUE ELSE host_eliminated END,
           host_eliminated_level = CASE WHEN $5 THEN $4 ELSE host_eliminated_level END,
           host_eliminated_lives = CASE WHEN $5 THEN COALESCE($6, 0) ELSE host_eliminated_lives END,
           updated_at = NOW()
         WHERE id = $1`,
        [row.id, pts, words, lvl, eliminated, lives]
      );
    } else {
      await client.query(
        `UPDATE challenge_rounds
         SET guest_score = $3, guest_submitted = TRUE,
             guest_lives = COALESCE($4, guest_lives),
             guest_words = COALESCE($5, guest_words),
             updated_at = NOW()
         WHERE challenge_id = $1 AND level = $2`,
        [row.id, lvl, pts, lives, wordsLv]
      );
      await client.query(
        `UPDATE challenges SET
           guest_total_points = guest_total_points + $2,
           guest_words_accum = GREATEST(guest_words_accum, $3),
           current_level = GREATEST(current_level, $4),
           round_guest_score = $2,
           guest_submitted_round = TRUE,
           guest_lives = COALESCE($6, guest_lives),
           guest_eliminated = CASE WHEN $5 THEN TRUE ELSE guest_eliminated END,
           guest_eliminated_level = CASE WHEN $5 THEN $4 ELSE guest_eliminated_level END,
           guest_eliminated_lives = CASE WHEN $5 THEN COALESCE($6, 0) ELSE guest_eliminated_lives END,
           updated_at = NOW()
         WHERE id = $1`,
        [row.id, pts, words, lvl, eliminated, lives]
      );
    }
  } else if (eliminated) {
    await client.query(
      `UPDATE challenges SET
         host_eliminated = CASE WHEN $2 THEN TRUE ELSE host_eliminated END,
         guest_eliminated = CASE WHEN $3 THEN TRUE ELSE guest_eliminated END,
         host_eliminated_level = CASE WHEN $2 THEN $4 ELSE host_eliminated_level END,
         guest_eliminated_level = CASE WHEN $3 THEN $4 ELSE guest_eliminated_level END,
         host_eliminated_lives = CASE WHEN $2 THEN COALESCE($5, 0) ELSE host_eliminated_lives END,
         guest_eliminated_lives = CASE WHEN $3 THEN COALESCE($5, 0) ELSE guest_eliminated_lives END,
         host_lives = CASE WHEN $2 THEN COALESCE($5, host_lives) ELSE host_lives END,
         guest_lives = CASE WHEN $3 THEN COALESCE($5, guest_lives) ELSE guest_lives END,
         updated_at = NOW()
       WHERE id = $1`,
      [row.id, isHost, isGuest, lvl, lives]
    );
  }

  await resolveStoredRounds(client, row.id);
  return !alreadySubmitted;
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
      `INSERT INTO leaderboard (player_id, display_name, words_spelled, mp_wins, mp_losses, mp_total_score, mp_words_spelled, updated_at)
       VALUES ($1, 'Player', $2, $3, $4, $5, $2, NOW())
       ON CONFLICT (player_id) DO UPDATE SET
         mp_wins = leaderboard.mp_wins + $3,
         mp_losses = leaderboard.mp_losses + $4,
         mp_total_score = leaderboard.mp_total_score + $5,
         mp_words_spelled = leaderboard.mp_words_spelled + $2,
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
              words_spelled, mp_wins, mp_losses, mp_total_score, mp_words_spelled, updated_at
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
    const rounds = await getRecentRounds(pool, r2.rows[0].id);
    res.json(rowToChallenge(r2.rows[0], rounds));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'join_failed' });
  }
});

app.get('/api/challenges/history/:playerId', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const playerId = req.params.playerId;
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 12));
    const { rows } = await pool.query(
      `SELECT code, start_level, current_level, host_id, host_name, guest_id, guest_name,
              host_wins, guest_wins, host_total_points, guest_total_points,
              host_words_accum, guest_words_accum, winner_id, match_summary,
              status, updated_at
       FROM challenges
       WHERE status = 'completed'
         AND (host_id = $1 OR guest_id = $1)
       ORDER BY updated_at DESC
       LIMIT $2`,
      [playerId, limit]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'history_failed' });
  }
});

/** Active matches you can resume (not eliminated). Must register before /api/challenges/:code */
app.get('/api/challenges/active/:playerId', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    await expireInactiveChallenges();
    const playerId = req.params.playerId;
    if (!playerId || typeof playerId !== 'string') {
      return res.status(400).json({ error: 'player_id required' });
    }
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const { rows } = await pool.query(
      `SELECT code, seed, start_level, current_level,
              host_id, host_name, guest_id, guest_name,
              host_wins, guest_wins,
              host_total_points, guest_total_points,
              host_words_accum, guest_words_accum,
              host_eliminated, guest_eliminated,
              status, updated_at
       FROM challenges
       WHERE status = 'active'
         AND guest_id IS NOT NULL
         AND (
           (host_id = $1 AND host_eliminated = FALSE)
           OR (guest_id = $1 AND guest_eliminated = FALSE)
         )
       ORDER BY updated_at DESC
       LIMIT $2`,
      [playerId, limit]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'active_list_failed' });
  }
});

app.post('/api/challenges/:code/rejoin', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const c = req.params.code.trim().toUpperCase();
    const { player_id } = req.body || {};
    if (!player_id || typeof player_id !== 'string') {
      return res.status(400).json({ error: 'player_id required' });
    }
    const { rows } = await pool.query('SELECT * FROM challenges WHERE code = $1', [c]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.status !== 'active') return res.status(410).json({ error: 'inactive' });
    const isHost = row.host_id === player_id;
    const isGuest = row.guest_id === player_id;
    if (!isHost && !isGuest) return res.status(403).json({ error: 'not_in_challenge' });
    if (isHost && !row.guest_id) {
      return res.status(400).json({ error: 'no_opponent' });
    }
    await pool.query(
      `UPDATE challenges SET last_rejoin_player_id = $1, last_rejoin_at = NOW(), updated_at = NOW() WHERE code = $2`,
      [player_id, c]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'rejoin_notify_failed' });
  }
});

app.get('/api/challenges/:code', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    await expireInactiveChallenges();
    const c = req.params.code.trim().toUpperCase();
    const { rows } = await pool.query('SELECT * FROM challenges WHERE code = $1', [c]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    const rounds = await getRecentRounds(pool, row.id);
    res.json(rowToChallenge(row, rounds));
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
    const { player_id, level, level_score, words_spelled, lives_remaining, words_this_level } = req.body || {};
    if (!player_id || level == null || level_score == null) {
      return res.status(400).json({ error: 'player_id, level, level_score required' });
    }
    const lvl = Math.floor(Number(level));
    const pts = Math.round(Number(level_score));
    const words = Math.max(0, Math.floor(Number(words_spelled) || 0));

    await client.query('BEGIN');
    await expireInactiveChallenges(client);
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
    await submitChallengeScore(client, row, player_id, lvl, pts, words, false, lives_remaining, words_this_level);
    const { rows: rows3 } = await client.query('SELECT * FROM challenges WHERE id = $1 FOR UPDATE', [row.id]);
    const cur = rows3[0];
    await finalizeMatchIfNeeded(client, cur);

    await client.query('COMMIT');
    const { rows: finalRows } = await pool.query('SELECT * FROM challenges WHERE code = $1', [c]);
    const rounds = await getRecentRounds(pool, finalRows[0].id);
    res.json(rowToChallenge(finalRows[0], rounds));
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    if (e && e.status) {
      return res.status(e.status).json({ error: e.message || 'challenge_error' });
    }
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
    const { player_id, level, level_score, words_spelled, lives_remaining, words_this_level } = req.body || {};
    if (!player_id || level == null || level_score == null) {
      return res.status(400).json({ error: 'player_id, level, level_score required' });
    }
    const lvl = Math.floor(Number(level));
    const pts = Math.round(Number(level_score));
    const words = Math.max(0, Math.floor(Number(words_spelled) || 0));

    await client.query('BEGIN');
    await expireInactiveChallenges(client);
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
      const rounds = await getRecentRounds(pool, fr[0].id);
      return res.json(rowToChallenge(fr[0], rounds));
    }
    if (isGuest && row.guest_eliminated) {
      await client.query('COMMIT');
      const { rows: fr } = await pool.query('SELECT * FROM challenges WHERE code = $1', [c]);
      const rounds = await getRecentRounds(pool, fr[0].id);
      return res.json(rowToChallenge(fr[0], rounds));
    }

    await submitChallengeScore(client, row, player_id, lvl, pts, words, true, lives_remaining, words_this_level);
    const { rows: rows3 } = await client.query('SELECT * FROM challenges WHERE id = $1 FOR UPDATE', [row.id]);
    const cur = rows3[0];
    await finalizeMatchIfNeeded(client, cur);

    await client.query('COMMIT');
    const { rows: finalRows } = await pool.query('SELECT * FROM challenges WHERE code = $1', [c]);
    const rounds = await getRecentRounds(pool, finalRows[0].id);
    res.json(rowToChallenge(finalRows[0], rounds));
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    if (e && e.status) {
      return res.status(e.status).json({ error: e.message || 'challenge_error' });
    }
    console.error(e);
    res.status(500).json({ error: 'eliminate_failed' });
  } finally {
    client.release();
  }
});

app.get('/api/players/:playerId', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const playerId = req.params.playerId;
    if (!playerId || typeof playerId !== 'string') {
      return res.status(400).json({ error: 'player_id required' });
    }
    const { rows } = await pool.query(
      'SELECT player_id, display_name FROM leaderboard WHERE player_id = $1',
      [playerId]
    );
    if (!rows[0]) {
      return res.json({ player_id: playerId, display_name: 'Player' });
    }
    res.json({ player_id: rows[0].player_id, display_name: rows[0].display_name || 'Player' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'player_lookup_failed' });
  }
});

app.get('/api/friends/:playerId', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const playerId = req.params.playerId;
    if (!playerId || typeof playerId !== 'string') {
      return res.status(400).json({ error: 'player_id required' });
    }

    const { rows: incomingRows } = await pool.query(
      `SELECT fr.id, fr.from_player_id, fr.created_at,
              COALESCE(lb.display_name, 'Player') AS display_name
       FROM friend_requests fr
       LEFT JOIN leaderboard lb ON lb.player_id = fr.from_player_id
       WHERE fr.to_player_id = $1 AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      [playerId]
    );

    const { rows: outgoingRows } = await pool.query(
      `SELECT fr.id, fr.to_player_id, fr.created_at,
              COALESCE(lb.display_name, 'Player') AS display_name
       FROM friend_requests fr
       LEFT JOIN leaderboard lb ON lb.player_id = fr.to_player_id
       WHERE fr.from_player_id = $1 AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      [playerId]
    );

    const { rows: friendRows } = await pool.query(
      `SELECT
         CASE WHEN fr.from_player_id = $1 THEN fr.to_player_id ELSE fr.from_player_id END AS player_id,
         COALESCE(lb.display_name, 'Player') AS display_name,
         fr.updated_at
       FROM friend_requests fr
       LEFT JOIN leaderboard lb ON lb.player_id = CASE
         WHEN fr.from_player_id = $1 THEN fr.to_player_id
         ELSE fr.from_player_id
       END
       WHERE fr.status = 'accepted'
         AND (fr.from_player_id = $1 OR fr.to_player_id = $1)
       ORDER BY fr.updated_at DESC`,
      [playerId]
    );

    res.json({
      friends: friendRows.map((r) => ({
        player_id: r.player_id,
        display_name: r.display_name,
        updated_at: r.updated_at
      })),
      incoming: incomingRows.map((r) => ({
        id: r.id,
        player_id: r.from_player_id,
        display_name: r.display_name,
        created_at: r.created_at
      })),
      outgoing: outgoingRows.map((r) => ({
        id: r.id,
        player_id: r.to_player_id,
        display_name: r.display_name,
        created_at: r.created_at
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'friends_list_failed' });
  }
});

app.post('/api/friends/request', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const client = await pool.connect();
  try {
    const { from_player_id, to_player_id } = req.body || {};
    if (!from_player_id || !to_player_id || typeof from_player_id !== 'string' || typeof to_player_id !== 'string') {
      return res.status(400).json({ error: 'from_player_id and to_player_id required' });
    }
    if (from_player_id === to_player_id) {
      return res.status(400).json({ error: 'cannot_friend_self' });
    }

    await client.query('BEGIN');

    if (await areFriends(client, from_player_id, to_player_id)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'already_friends' });
    }

    const reverse = await client.query(
      `SELECT id FROM friend_requests
       WHERE from_player_id = $1 AND to_player_id = $2 AND status = 'pending'
       LIMIT 1`,
      [to_player_id, from_player_id]
    );
    if (reverse.rows[0]) {
      await client.query(
        `UPDATE friend_requests SET status = 'accepted', updated_at = NOW() WHERE id = $1`,
        [reverse.rows[0].id]
      );
      await client.query('COMMIT');
      return res.json({ ok: true, auto_accepted: true });
    }

    const existing = await client.query(
      `SELECT id, status FROM friend_requests
       WHERE from_player_id = $1 AND to_player_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [from_player_id, to_player_id]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].status === 'pending') {
        await client.query('ROLLBACK');
        return res.json({ ok: true, already_pending: true });
      }
      if (existing.rows[0].status === 'accepted') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'already_friends' });
      }
    }

    await client.query(
      `INSERT INTO friend_requests (from_player_id, to_player_id, status, created_at, updated_at)
       VALUES ($1, $2, 'pending', NOW(), NOW())`,
      [from_player_id, to_player_id]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    console.error(e);
    res.status(500).json({ error: 'friend_request_failed' });
  } finally {
    client.release();
  }
});

app.post('/api/friends/respond', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { player_id, from_player_id, accept } = req.body || {};
    if (!player_id || !from_player_id) {
      return res.status(400).json({ error: 'player_id and from_player_id required' });
    }
    const status = accept ? 'accepted' : 'declined';
    const { rowCount } = await pool.query(
      `UPDATE friend_requests
       SET status = $3, updated_at = NOW()
       WHERE from_player_id = $1 AND to_player_id = $2 AND status = 'pending'`,
      [from_player_id, player_id, status]
    );
    if (!rowCount) return res.status(404).json({ error: 'request_not_found' });
    res.json({ ok: true, status });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'friend_respond_failed' });
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
