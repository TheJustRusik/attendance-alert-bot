import pg from 'pg';
import { config } from './config.js';

// bigint (Telegram ID, count(*)) -> number
pg.types.setTypeParser(20, (v) => Number(v));

export const pgPool = new pg.Pool({ connectionString: config.databaseUrl });
const q = (text, params) => pgPool.query(text, params);

export async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id         BIGINT PRIMARY KEY,
      username   TEXT,
      first_name TEXT,
      role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','moderator','admin')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS pools (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      owner_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pools_name_uq ON pools (lower(name));
    CREATE TABLE IF NOT EXISTS pool_members (
      pool_id   INT    NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
      user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (pool_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS pool_members_user_idx ON pool_members (user_id);
    CREATE TABLE IF NOT EXISTS auto_attendance (
      user_id         BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      login_mask      TEXT NOT NULL,
      enc_credentials TEXT NOT NULL,
      enabled         BOOLEAN NOT NULL DEFAULT true,
      last_run_at     TIMESTAMPTZ,
      last_status     TEXT,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS pool_schedules (
      id                SERIAL PRIMARY KEY,
      pool_id           INT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
      day_of_week       SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
      start_minute      SMALLINT NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
      end_minute        SMALLINT NOT NULL CHECK (end_minute BETWEEN 1 AND 1440 AND end_minute > start_minute),
      scout_user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
      enabled           BOOLEAN NOT NULL DEFAULT true,
      stop_on_detect    BOOLEAN NOT NULL DEFAULT true,
      created_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
      last_window_key   TEXT,
      last_triggered_at TIMESTAMPTZ,
      last_status       TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS pool_schedules_pool_idx ON pool_schedules (pool_id);
    CREATE INDEX IF NOT EXISTS pool_schedules_active_idx ON pool_schedules (enabled, day_of_week);
  `);
}

/** Назначает админов из ENV, только если в базе нет ни одного админа. */
export async function ensureEnvAdmins(ids) {
  const { rows } = await q(`SELECT count(*) AS c FROM users WHERE role = 'admin'`);
  if (rows[0].c > 0 || ids.length === 0) return false;
  for (const id of ids) {
    await q(
      `INSERT INTO users (id, role) VALUES ($1, 'admin')
       ON CONFLICT (id) DO UPDATE SET role = 'admin'`,
      [id],
    );
  }
  return true;
}

// ---------- users ----------
export async function upsertUser(from) {
  const { rows } = await q(
    `INSERT INTO users (id, username, first_name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name
     RETURNING *`,
    [from.id, from.username ?? null, from.first_name ?? null],
  );
  return rows[0];
}

export async function findUser(input) {
  if (/^\d+$/.test(input)) {
    const { rows } = await q('SELECT * FROM users WHERE id = $1', [Number(input)]);
    return rows[0];
  }
  const { rows } = await q('SELECT * FROM users WHERE lower(username) = lower($1)', [input]);
  return rows[0];
}

export async function getUser(id) {
  const { rows } = await q('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0];
}

export async function setRole(id, role) {
  await q('UPDATE users SET role = $2 WHERE id = $1', [id, role]);
}

export async function listModerators(limit, offset) {
  const { rows } = await q(
    `SELECT * FROM users WHERE role = 'moderator' ORDER BY created_at LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}

export async function listAdminIds() {
  const { rows } = await q(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC`);
  return rows.map((r) => r.id);
}

export async function countUsers() {
  const { rows } = await q(`SELECT count(*) AS c FROM users`);
  return Number(rows[0]?.c ?? 0);
}

export async function listUsers(limit, offset) {
  const { rows } = await q(
    `SELECT * FROM users
      ORDER BY CASE role WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END, created_at ASC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}

export async function stats() {
  const { rows } = await q(`
    SELECT
      (SELECT count(*) FROM users) AS users,
      (SELECT count(*) FROM users WHERE role = 'moderator') AS moderators,
      (SELECT count(*) FROM users WHERE role = 'admin') AS admins,
      (SELECT count(*) FROM pools) AS pools,
      (SELECT count(*) FROM pool_members) AS memberships,
      (SELECT count(*) FROM auto_attendance) AS auto_attendance_total,
      (SELECT count(*) FROM auto_attendance WHERE enabled = true) AS auto_attendance_enabled,
      (SELECT count(*) FROM pool_schedules) AS pool_schedules_total,
      (SELECT count(*) FROM pool_schedules WHERE enabled = true) AS pool_schedules_enabled
  `);
  return rows[0];
}

// ---------- pools ----------
export async function createPool(name, ownerId) {
  const c = await pgPool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(
      'INSERT INTO pools (name, owner_id) VALUES ($1, $2) RETURNING *',
      [name, ownerId],
    );
    await c.query('INSERT INTO pool_members (pool_id, user_id) VALUES ($1, $2)', [rows[0].id, ownerId]);
    await c.query('COMMIT');
    return rows[0];
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export async function countPools() {
  const { rows } = await q(`SELECT count(*) AS c FROM pools`);
  return Number(rows[0]?.c ?? 0);
}

export async function findPoolByName(name) {
  const { rows } = await q(
    `SELECT p.*, u.username AS owner_username, u.first_name AS owner_first_name,
            (SELECT count(*) FROM pool_members m WHERE m.pool_id = p.id) AS members
       FROM pools p JOIN users u ON u.id = p.owner_id
      WHERE lower(p.name) = lower($1)`,
    [name.trim()],
  );
  return rows[0];
}

export async function getPool(id) {
  const { rows } = await q(
    `SELECT p.*, u.username AS owner_username, u.first_name AS owner_first_name,
            (SELECT count(*) FROM pool_members m WHERE m.pool_id = p.id) AS members
       FROM pools p JOIN users u ON u.id = p.owner_id
      WHERE p.id = $1`,
    [id],
  );
  return rows[0];
}

/** kind: 'pools' (все) | 'my' (где я участник) | 'own' (созданные мной) */
export async function listPools({ kind, userId, limit, offset }) {
  const params = [];
  let where = '';
  if (kind === 'my') {
    params.push(userId);
    where = `WHERE EXISTS (SELECT 1 FROM pool_members m WHERE m.pool_id = p.id AND m.user_id = $1)`;
  } else if (kind === 'own') {
    params.push(userId);
    where = 'WHERE p.owner_id = $1';
  }
  params.push(limit, offset);
  const { rows } = await q(
    `SELECT p.id, p.name, p.owner_id,
            (SELECT count(*) FROM pool_members m WHERE m.pool_id = p.id) AS members
       FROM pools p ${where}
      ORDER BY lower(p.name)
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

/** Возвращает id участников пула, которых удалили вместе с ним. */
export async function deletePool(id) {
  const ids = await memberIds(id);
  await q('DELETE FROM pools WHERE id = $1', [id]);
  return ids;
}

// ---------- members ----------
export async function isMember(poolId, userId) {
  const { rows } = await q('SELECT 1 FROM pool_members WHERE pool_id = $1 AND user_id = $2', [poolId, userId]);
  return rows.length > 0;
}

export async function joinPool(poolId, userId) {
  await q(
    'INSERT INTO pool_members (pool_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [poolId, userId],
  );
}

export async function leavePool(poolId, userId) {
  const r = await q('DELETE FROM pool_members WHERE pool_id = $1 AND user_id = $2', [poolId, userId]);
  return r.rowCount > 0;
}

export async function memberIds(poolId, excludeId = null) {
  const { rows } = await q(
    'SELECT user_id FROM pool_members WHERE pool_id = $1 AND ($2::bigint IS NULL OR user_id <> $2)',
    [poolId, excludeId],
  );
  return rows.map((r) => r.user_id);
}

export async function listMembers(poolId, limit, offset) {
  const { rows } = await q(
    `SELECT u.id, u.username, u.first_name
       FROM pool_members m JOIN users u ON u.id = m.user_id
      WHERE m.pool_id = $1
      ORDER BY m.joined_at
      LIMIT $2 OFFSET $3`,
    [poolId, limit, offset],
  );
  return rows;
}

// ---------- auto_attendance ----------
export async function saveAutoAttendance(userId, loginMask, encCredentials) {
  const { rows } = await q(
    `INSERT INTO auto_attendance (user_id, login_mask, enc_credentials, enabled, updated_at)
     VALUES ($1, $2, $3, true, now())
     ON CONFLICT (user_id) DO UPDATE SET
       login_mask = EXCLUDED.login_mask,
       enc_credentials = EXCLUDED.enc_credentials,
       enabled = true,
       updated_at = now()
     RETURNING *`,
    [userId, loginMask, encCredentials],
  );
  return rows[0];
}

export async function getAutoAttendance(userId) {
  const { rows } = await q('SELECT * FROM auto_attendance WHERE user_id = $1', [userId]);
  return rows[0] || null;
}

export async function setAutoAttendanceEnabled(userId, enabled) {
  const { rows } = await q(
    `UPDATE auto_attendance SET enabled = $2, updated_at = now()
      WHERE user_id = $1
      RETURNING *`,
    [userId, Boolean(enabled)],
  );
  return rows[0] || null;
}

export async function updateAutoAttendanceRun(userId, lastStatus) {
  await q(
    `UPDATE auto_attendance
        SET last_run_at = now(), last_status = $2, updated_at = now()
      WHERE user_id = $1`,
    [userId, lastStatus],
  );
}

export async function deleteAutoAttendance(userId) {
  const r = await q('DELETE FROM auto_attendance WHERE user_id = $1', [userId]);
  return r.rowCount > 0;
}

export async function getAutoAttendanceForUsers(userIds) {
  if (!userIds || userIds.length === 0) return [];
  const { rows } = await q(
    `SELECT user_id, login_mask, enc_credentials, enabled
       FROM auto_attendance
      WHERE user_id = ANY($1::bigint[])`,
    [userIds],
  );
  return rows;
}

// ---------- pool_schedules ----------
const SCHEDULE_SELECT = `
  SELECT s.*,
         p.name AS pool_name,
         u.username AS scout_username,
         u.first_name AS scout_first_name,
         aa.login_mask AS scout_login_mask,
         aa.enabled AS scout_aa_enabled
    FROM pool_schedules s
    JOIN pools p ON p.id = s.pool_id
    LEFT JOIN users u ON u.id = s.scout_user_id
    LEFT JOIN auto_attendance aa ON aa.user_id = s.scout_user_id
`;

export async function createPoolSchedule({
  poolId,
  dayOfWeek,
  startMinute,
  endMinute,
  scoutUserId = null,
  createdBy = null,
  stopOnDetect = true,
}) {
  const { rows } = await q(
    `INSERT INTO pool_schedules
       (pool_id, day_of_week, start_minute, end_minute, scout_user_id, created_by, stop_on_detect)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [poolId, dayOfWeek, startMinute, endMinute, scoutUserId ?? null, createdBy ?? null, Boolean(stopOnDetect)],
  );
  return getPoolSchedule(rows[0].id);
}

export async function getPoolSchedule(id) {
  const { rows } = await q(`${SCHEDULE_SELECT} WHERE s.id = $1`, [id]);
  return rows[0] || null;
}

export async function listPoolSchedules(poolId) {
  const { rows } = await q(
    `${SCHEDULE_SELECT}
      WHERE s.pool_id = $1
      ORDER BY s.day_of_week ASC, s.start_minute ASC, s.id ASC`,
    [poolId],
  );
  return rows;
}

export async function listAllPoolSchedules(limit, offset) {
  const { rows } = await q(
    `${SCHEDULE_SELECT}
      ORDER BY s.enabled DESC, s.day_of_week ASC, s.start_minute ASC, s.id ASC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}

export async function countPoolSchedules() {
  const { rows } = await q(`SELECT count(*) AS c FROM pool_schedules`);
  return Number(rows[0]?.c ?? 0);
}

export async function listEnabledPoolSchedules() {
  const { rows } = await q(
    `${SCHEDULE_SELECT}
      WHERE s.enabled = true
      ORDER BY s.day_of_week ASC, s.start_minute ASC, s.id ASC`,
  );
  return rows;
}

export async function updatePoolSchedule(id, fields) {
  const sets = [];
  const params = [id];
  const push = (col, val) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  if (Object.prototype.hasOwnProperty.call(fields, 'enabled')) push('enabled', Boolean(fields.enabled));
  if (Object.prototype.hasOwnProperty.call(fields, 'scoutUserId')) push('scout_user_id', fields.scoutUserId ?? null);
  if (Object.prototype.hasOwnProperty.call(fields, 'stopOnDetect')) push('stop_on_detect', Boolean(fields.stopOnDetect));
  if (Object.prototype.hasOwnProperty.call(fields, 'dayOfWeek')) push('day_of_week', Number(fields.dayOfWeek));
  if (Object.prototype.hasOwnProperty.call(fields, 'startMinute')) push('start_minute', Number(fields.startMinute));
  if (Object.prototype.hasOwnProperty.call(fields, 'endMinute')) push('end_minute', Number(fields.endMinute));

  if (sets.length === 0) return getPoolSchedule(id);

  sets.push('updated_at = now()');
  const r = await q(`UPDATE pool_schedules SET ${sets.join(', ')} WHERE id = $1`, params);
  if (r.rowCount === 0) return null;
  return getPoolSchedule(id);
}

export async function markPoolScheduleTriggered(id, windowKey, statusText) {
  await q(
    `UPDATE pool_schedules
        SET last_window_key = $2,
            last_triggered_at = now(),
            last_status = $3,
            updated_at = now()
      WHERE id = $1`,
    [id, windowKey, statusText],
  );
}

export async function updatePoolScheduleStatus(id, statusText) {
  await q(
    `UPDATE pool_schedules
        SET last_status = $2,
            updated_at = now()
      WHERE id = $1`,
    [id, statusText],
  );
}

export async function deletePoolSchedule(id) {
  const r = await q('DELETE FROM pool_schedules WHERE id = $1', [id]);
  return r.rowCount > 0;
}

export async function listEligibleScoutsForPool(poolId) {
  const { rows } = await q(
    `SELECT u.id AS user_id,
            u.username,
            u.first_name,
            aa.login_mask,
            aa.enc_credentials
       FROM pool_members m
       JOIN users u ON u.id = m.user_id
       JOIN auto_attendance aa ON aa.user_id = m.user_id
      WHERE m.pool_id = $1
        AND aa.enabled = true
      ORDER BY m.joined_at ASC`,
    [poolId],
  );
  return rows;
}
