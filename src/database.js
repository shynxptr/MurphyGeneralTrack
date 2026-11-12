const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'tracker.db');
const db = new DatabaseSync(DB_PATH);

// Optimasi performa SQLite
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');

// Inisialisasi tabel
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tracked_roles (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    role_name TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS tracked_users (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS tracked_channels (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS command_roles (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    role_name TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS message_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT UNIQUE NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_tag TEXT NOT NULL,
    content TEXT NOT NULL,
    word_count INTEGER NOT NULL,
    message_url TEXT NOT NULL,
    date_wib TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_logs_guild_date ON message_logs (guild_id, date_wib);
  CREATE INDEX IF NOT EXISTS idx_logs_guild_user_date ON message_logs (guild_id, user_id, date_wib);
  CREATE INDEX IF NOT EXISTS idx_logs_created ON message_logs (guild_id, created_at);
`);

/**
 * Mengambil tanggal format YYYY-MM-DD dalam zona waktu Asia/Jakarta (WIB)
 * @param {Date} [date=new Date()]
 * @returns {string}
 */
function getDateWIB(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TIMEZONE || 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date); // menghasilkan YYYY-MM-DD
}

/**
 * Mengambil tanggal kemarin (H-1) dalam format YYYY-MM-DD WIB
 * @param {Date} [now=new Date()]
 * @returns {string}
 */
function getYesterdayDateWIB(now = new Date()) {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return getDateWIB(yesterday);
}

/**
 * Mengambil jam & menit saat ini dalam zona waktu WIB (Asia/Jakarta)
 * @param {Date} [date=new Date()]
 * @returns {{ dateWib: string, hour: number, minute: number }}
 */
function getTimePartsWIB(date = new Date()) {
  const timeZone = process.env.TIMEZONE || 'Asia/Jakarta';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);

  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }
  const hour = parseInt(map.hour, 10) % 24;
  const minute = parseInt(map.minute, 10);
  return {
    dateWib: `${map.year}-${map.month}-${map.day}`,
    hour,
    minute,
  };
}

/**
 * Mengambil waktu lengkap dalam format WIB untuk tampilan log
 * @param {Date} [date=new Date()]
 * @returns {string}
 */
function formatDateTimeWIB(date = new Date()) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: process.env.TIMEZONE || 'Asia/Jakarta',
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
}

// ==========================================
// MANAJEMEN KONFIGURASI (SETTINGS)
// ==========================================

const stmtGetSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const stmtSetSetting = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function getSetting(key, defaultValue = null) {
  const row = stmtGetSetting.get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  stmtSetSetting.run(key, String(value));
}

function getConfig() {
  const parsedHour = parseInt(getSetting('reminder_hour', '20'), 10);
  const parsedCooldown = parseInt(getSetting('cooldown_seconds', '5'), 10);
  const parsedMaxConsecutive = parseInt(getSetting('max_consecutive', '3'), 10);
  return {
    mainGuildId: getSetting('main_guild_id', process.env.MAIN_GUILD_ID || ''),
    logChannelId: getSetting('log_channel_id', process.env.LOG_CHANNEL_ID || ''),
    dailyTarget: parseInt(getSetting('daily_target', '100'), 10) || 100,
    minWords: parseInt(getSetting('min_words', '4'), 10) || 4,
    realtimeLog: getSetting('realtime_log', 'true') === 'true',
    autoRecap: getSetting('auto_recap', 'true') === 'true',
    reminderEnabled: getSetting('reminder_enabled', 'true') === 'true',
    reminderHour: Number.isNaN(parsedHour) ? 20 : parsedHour,
    reminderChannelId: getSetting('reminder_channel_id', ''),
    cooldownSeconds: Number.isNaN(parsedCooldown) ? 5 : parsedCooldown,
    maxConsecutive: Number.isNaN(parsedMaxConsecutive) ? 3 : parsedMaxConsecutive,
    prefix: getSetting('command_prefix', process.env.BOT_PREFIX || 'g'),
  };
}

// ==========================================
// MANAJEMEN ROLE YANG DIIZINKAN PAKAI COMMAND
// ==========================================

function addCommandRole(guildId, roleId, roleName) {
  const stmt = db.prepare(`
    INSERT INTO command_roles (guild_id, role_id, role_name, added_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, role_id) DO UPDATE SET role_name = excluded.role_name
  `);
  stmt.run(guildId, roleId, roleName, new Date().toISOString());
}

function removeCommandRole(guildId, roleId) {
  const stmt = db.prepare('DELETE FROM command_roles WHERE guild_id = ? AND role_id = ?');
  return stmt.run(guildId, roleId).changes > 0;
}

function getCommandRoles(guildId) {
  const stmt = db.prepare('SELECT * FROM command_roles WHERE guild_id = ? ORDER BY added_at ASC');
  return stmt.all(guildId);
}

// ==========================================
// MANAJEMEN ROLE, USER, & CHANNEL YANG DILACAK
// ==========================================

function addTrackedRole(guildId, roleId, roleName) {
  const stmt = db.prepare(`
    INSERT INTO tracked_roles (guild_id, role_id, role_name, added_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, role_id) DO UPDATE SET role_name = excluded.role_name
  `);
  stmt.run(guildId, roleId, roleName, new Date().toISOString());
}

function removeTrackedRole(guildId, roleId) {
  const stmt = db.prepare('DELETE FROM tracked_roles WHERE guild_id = ? AND role_id = ?');
  return stmt.run(guildId, roleId).changes > 0;
}

function getTrackedRoles(guildId) {
  const stmt = db.prepare('SELECT * FROM tracked_roles WHERE guild_id = ? ORDER BY added_at ASC');
  return stmt.all(guildId);
}

function addTrackedUser(guildId, userId, username) {
  const stmt = db.prepare(`
    INSERT INTO tracked_users (guild_id, user_id, username, added_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET username = excluded.username
  `);
  stmt.run(guildId, userId, username, new Date().toISOString());
}

function removeTrackedUser(guildId, userId) {
  const stmt = db.prepare('DELETE FROM tracked_users WHERE guild_id = ? AND user_id = ?');
  return stmt.run(guildId, userId).changes > 0;
}

function getTrackedUsers(guildId) {
  const stmt = db.prepare('SELECT * FROM tracked_users WHERE guild_id = ? ORDER BY added_at ASC');
  return stmt.all(guildId);
}

function addTrackedChannel(guildId, channelId, channelName) {
  const stmt = db.prepare(`
    INSERT INTO tracked_channels (guild_id, channel_id, channel_name, added_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, channel_id) DO UPDATE SET channel_name = excluded.channel_name
  `);
  stmt.run(guildId, channelId, channelName, new Date().toISOString());
}

function removeTrackedChannel(guildId, channelId) {
  const stmt = db.prepare('DELETE FROM tracked_channels WHERE guild_id = ? AND channel_id = ?');
  return stmt.run(guildId, channelId).changes > 0;
}

function getTrackedChannels(guildId) {
  const stmt = db.prepare('SELECT * FROM tracked_channels WHERE guild_id = ? ORDER BY added_at ASC');
  return stmt.all(guildId);
}

// ==========================================
// PENCATATAN PESAN & LOG BUKTI
// ==========================================

const stmtInsertLog = db.prepare(`
  INSERT OR IGNORE INTO message_logs (
    message_id, guild_id, channel_id, channel_name,
    user_id, user_tag, content, word_count,
    message_url, date_wib, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtLastUserMsg = db.prepare(`
  SELECT content, created_at FROM message_logs
  WHERE guild_id = ? AND user_id = ?
  ORDER BY id DESC LIMIT 1
`);

const stmtUserDailyCount = db.prepare(`
  SELECT COUNT(*) AS count, COALESCE(SUM(word_count), 0) AS words
  FROM message_logs
  WHERE guild_id = ? AND user_id = ? AND date_wib = ?
`);

const stmtGetLogByMessageId = db.prepare(`
  SELECT * FROM message_logs WHERE message_id = ?
`);

const stmtDeleteLogByMessageId = db.prepare(`
  DELETE FROM message_logs WHERE message_id = ?
`);

const stmtUpdateLogByMessageId = db.prepare(`
  UPDATE message_logs
  SET content = ?, word_count = ?
  WHERE message_id = ?
`);

function getLastUserMessage(guildId, userId) {
  return stmtLastUserMsg.get(guildId, userId) || null;
}

function getLogByMessageId(messageId) {
  return stmtGetLogByMessageId.get(messageId) || null;
}

function removeMessageLogById(messageId) {
  const existing = getLogByMessageId(messageId);
  if (!existing) return null;
  stmtDeleteLogByMessageId.run(messageId);
  const daily = stmtUserDailyCount.get(existing.guild_id, existing.user_id, existing.date_wib);
  return {
    removedLog: existing,
    dailyCount: daily ? Number(daily.count) : 0,
    dailyWords: daily ? Number(daily.words) : 0,
  };
}

function updateMessageLogById(messageId, newContent, newWordCount) {
  const existing = getLogByMessageId(messageId);
  if (!existing) return null;
  stmtUpdateLogByMessageId.run(newContent, newWordCount, messageId);
  const daily = stmtUserDailyCount.get(existing.guild_id, existing.user_id, existing.date_wib);
  return {
    updatedLog: existing,
    dailyCount: daily ? Number(daily.count) : 0,
    dailyWords: daily ? Number(daily.words) : 0,
  };
}

function recordMessageLog(data) {
  const dateWib = data.dateWib || getDateWIB(new Date(data.createdAt || Date.now()));
  stmtInsertLog.run(
    data.messageId,
    data.guildId,
    data.channelId,
    data.channelName,
    data.userId,
    data.userTag,
    data.content,
    data.wordCount,
    data.messageUrl,
    dateWib,
    data.createdAt || Date.now()
  );

  const daily = stmtUserDailyCount.get(data.guildId, data.userId, dateWib);
  return {
    dateWib,
    dailyCount: daily ? Number(daily.count) : 1,
    dailyWords: daily ? Number(daily.words) : data.wordCount,
  };
}

// ==========================================
// STATISTIK, MONITORING, & BUKTI LOG
// ==========================================

function getUserStats(guildId, userId, targetDateWib = getDateWIB()) {
  const daily = stmtUserDailyCount.get(guildId, userId, targetDateWib);
  const { dailyTarget } = getConfig();

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekly = db.prepare(`
    SELECT
      COALESCE(SUM(day_count), 0) AS count,
      COALESCE(SUM(day_words), 0) AS words,
      COALESCE(SUM(CASE WHEN day_count >= ? THEN 1 ELSE 0 END), 0) AS completed_days
    FROM (
      SELECT date_wib, COUNT(*) AS day_count, COALESCE(SUM(word_count), 0) AS day_words
      FROM message_logs
      WHERE guild_id = ? AND user_id = ? AND created_at >= ?
      GROUP BY date_wib
    )
  `).get(dailyTarget, guildId, userId, sevenDaysAgo);

  const allTime = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(word_count), 0) AS words,
           ROUND(AVG(word_count), 1) AS avg_words
    FROM message_logs
    WHERE guild_id = ? AND user_id = ?
  `).get(guildId, userId);

  const recentLogs = db.prepare(`
    SELECT message_id, channel_name, content, word_count, message_url, date_wib, created_at
    FROM message_logs
    WHERE guild_id = ? AND user_id = ?
    ORDER BY id DESC LIMIT 5
  `).all(guildId, userId);

  return {
    dateWib: targetDateWib,
    dailyCount: Number(daily?.count || 0),
    dailyWords: Number(daily?.words || 0),
    weeklyCount: Number(weekly?.count || 0),
    weeklyWords: Number(weekly?.words || 0),
    weeklyCompletedDays: Number(weekly?.completed_days || 0),
    totalCount: Number(allTime?.count || 0),
    totalWords: Number(allTime?.words || 0),
    avgWords: Number(allTime?.avg_words || 0),
    recentLogs,
  };
}

function getMonitorData(guildId, period = 'today', dateWib = getDateWIB()) {
  const { dailyTarget } = getConfig();

  if (period === 'today') {
    return db.prepare(`
      SELECT user_id, MAX(user_tag) AS user_tag,
             COUNT(*) AS message_count,
             SUM(word_count) AS total_words,
             MAX(created_at) AS last_active
      FROM message_logs
      WHERE guild_id = ? AND date_wib = ?
      GROUP BY user_id
      ORDER BY message_count DESC, total_words DESC
      LIMIT 25
    `).all(guildId, dateWib);
  }

  if (period === '7days') {
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return db.prepare(`
      SELECT
        user_id,
        MAX(user_tag) AS user_tag,
        SUM(day_count) AS message_count,
        SUM(day_words) AS total_words,
        COUNT(*) AS active_days,
        SUM(CASE WHEN day_count >= ? THEN 1 ELSE 0 END) AS completed_days
      FROM (
        SELECT user_id, MAX(user_tag) AS user_tag, date_wib,
               COUNT(*) AS day_count, SUM(word_count) AS day_words
        FROM message_logs
        WHERE guild_id = ? AND created_at >= ?
        GROUP BY user_id, date_wib
      )
      GROUP BY user_id
      ORDER BY completed_days DESC, message_count DESC, total_words DESC
      LIMIT 25
    `).all(dailyTarget, guildId, since);
  }

  if (period === 'month') {
    const yearMonth = dateWib.slice(0, 7); // YYYY-MM
    return db.prepare(`
      SELECT
        user_id,
        MAX(user_tag) AS user_tag,
        SUM(day_count) AS message_count,
        SUM(day_words) AS total_words,
        COUNT(*) AS active_days,
        SUM(CASE WHEN day_count >= ? THEN 1 ELSE 0 END) AS completed_days
      FROM (
        SELECT user_id, MAX(user_tag) AS user_tag, date_wib,
               COUNT(*) AS day_count, SUM(word_count) AS day_words
        FROM message_logs
        WHERE guild_id = ? AND date_wib LIKE ?
        GROUP BY user_id, date_wib
      )
      GROUP BY user_id
      ORDER BY completed_days DESC, message_count DESC, total_words DESC
      LIMIT 25
    `).all(dailyTarget, guildId, `${yearMonth}%`);
  }

  // 'all'
  return db.prepare(`
    SELECT
      user_id,
      MAX(user_tag) AS user_tag,
      SUM(day_count) AS message_count,
      SUM(day_words) AS total_words,
      COUNT(*) AS active_days,
      SUM(CASE WHEN day_count >= ? THEN 1 ELSE 0 END) AS completed_days
    FROM (
      SELECT user_id, MAX(user_tag) AS user_tag, date_wib,
             COUNT(*) AS day_count, SUM(word_count) AS day_words
      FROM message_logs
      WHERE guild_id = ?
      GROUP BY user_id, date_wib
    )
    GROUP BY user_id
    ORDER BY completed_days DESC, message_count DESC, total_words DESC
    LIMIT 25
  `).all(dailyTarget, guildId);
}

function getMessageLogs({ guildId, userId = null, dateWib = null, limit = 15 }) {
  let query = `
    SELECT id, message_id, channel_id, channel_name, user_id, user_tag,
           content, word_count, message_url, date_wib, created_at
    FROM message_logs
    WHERE guild_id = ?
  `;
  const params = [guildId];

  if (userId) {
    query += ' AND user_id = ?';
    params.push(userId);
  }
  if (dateWib) {
    query += ' AND date_wib = ?';
    params.push(dateWib);
  }

  query += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params);
}

function resetLogs({ guildId, scope = 'today', userId = null, dateWib = getDateWIB() }) {
  if (scope === 'user' && userId) {
    return db.prepare('DELETE FROM message_logs WHERE guild_id = ? AND user_id = ?').run(guildId, userId).changes;
  }
  if (scope === 'today') {
    return db.prepare('DELETE FROM message_logs WHERE guild_id = ? AND date_wib = ?').run(guildId, dateWib).changes;
  }
  if (scope === 'all') {
    return db.prepare('DELETE FROM message_logs WHERE guild_id = ?').run(guildId).changes;
  }
  return 0;
}

module.exports = {
  db,
  getDateWIB,
  getYesterdayDateWIB,
  getTimePartsWIB,
  formatDateTimeWIB,
  getSetting,
  setSetting,
  getConfig,
  addCommandRole,
  removeCommandRole,
  getCommandRoles,
  addTrackedRole,
  removeTrackedRole,
  getTrackedRoles,
  addTrackedUser,
  removeTrackedUser,
  getTrackedUsers,
  addTrackedChannel,
  removeTrackedChannel,
  getTrackedChannels,
  getLastUserMessage,
  getLogByMessageId,
  removeMessageLogById,
  updateMessageLogById,
  recordMessageLog,
  getUserStats,
  getMonitorData,
  getLeaderboard: getMonitorData,
  getMessageLogs,
  resetLogs,
};
