const assert = require('node:assert');
const { validateMessage } = require('./validator');
const {
  setSetting,
  getConfig,
  addCommandRole,
  getCommandRoles,
  removeCommandRole,
  addTrackedRole,
  getTrackedRoles,
  addTrackedChannel,
  getTrackedChannels,
  recordMessageLog,
  getLastUserMessage,
  removeMessageLogById,
  updateMessageLogById,
  getUserStats,
  getMonitorData,
  getMessageLogs,
  resetLogs,
} = require('./database');
const { buildProgressBar, generateLogsCsv } = require('./utils');
const { hasCommandAccess } = require('./commands');
const { parsePrefixCommand } = require('./prefix-commands');
const { buildDailyRecapPayload, buildNightReminderPayload } = require('./scheduler');

console.log('🧪 Menjalankan Pengujian Sistem General Chat Tracker...\n');

// 1. Uji Aturan Minimal 4 Kata
{
  const res3Words = validateMessage('halo selamat pagi');
  assert.strictEqual(res3Words.valid, false, 'Pesan 3 kata harus ditolak');

  const res4Words = validateMessage('halo selamat pagi semuanya');
  assert.strictEqual(res4Words.valid, true, 'Pesan 4 kata valid harus diterima');
  assert.strictEqual(res4Words.wordCount, 4);
  console.log('✅ [LULUS] Filter minimal 4 kata berfungsi akurat.');
}

// 2. Uji Anti-Spam Kata Berulang & Gibberish
{
  const resRepeat = validateMessage('tes tes tes tes');
  assert.strictEqual(resRepeat.valid, false, 'Spam kata berulang harus ditolak');

  const resSingleChar = validateMessage('a b c d e');
  assert.strictEqual(resSingleChar.valid, false, 'Spam huruf tunggal harus ditolak');

  const resCommand = validateMessage('!rank lihat poin saya sekarang');
  assert.strictEqual(resCommand.valid, false, 'Command bot harus diabaikan');
  console.log('✅ [LULUS] Filter Anti-Spam (kata berulang, huruf tunggal, command bot) berfungsi akurat.');
}

// 3. Uji Pembersihan Link, Mention, dan Emoji
{
  const resFake4Words = validateMessage('halo <@123456789> <:pepe:987654321> https://discord.gg/invite 😂');
  assert.strictEqual(resFake4Words.valid, false, 'Mention, emoji, dan link tidak boleh dihitung sebagai kata');

  const resCleanWithEmoji = validateMessage('lagi main game bareng teman di voice 😂 <@123456>');
  assert.strictEqual(resCleanWithEmoji.valid, true, 'Pesan dengan >= 4 kata asli ditambah emoji harus tetap diterima');
  assert.strictEqual(resCleanWithEmoji.wordCount, 7);
  console.log('✅ [LULUS] Pembersihan URL, Mention, dan Emoji berfungsi akurat.');
}

// 4. Uji Deteksi Duplikat Pesan Beruntun
{
  const prevMsg = 'ayo ramaikan general chat malam ini teman teman';
  const resDup = validateMessage('Ayo ramaikan general chat malam ini teman teman!', {
    minWords: 4,
    lastMessageContent: prevMsg,
  });
  assert.strictEqual(resDup.valid, false, 'Pesan duplikat beruntun harus ditolak');
  console.log('✅ [LULUS] Deteksi pesan duplikat beruntun berfungsi akurat.');
}

// 5. Uji Pembatasan Akses Command Berdasarkan Role (/command-role)
{
  const testGuildId = 'test_guild_access_999';
  addCommandRole(testGuildId, 'role_allowed_cmd', 'Moderator');
  assert.strictEqual(getCommandRoles(testGuildId).length, 1);

  const mockAllowedInteraction = {
    guildId: testGuildId,
    user: { id: 'normal_staff_1' },
    memberPermissions: { has: () => false },
    member: {
      roles: {
        cache: new Map([['role_allowed_cmd', { id: 'role_allowed_cmd' }]]),
      },
    },
  };

  const mockBlockedInteraction = {
    guildId: testGuildId,
    user: { id: 'random_member_2' },
    memberPermissions: { has: () => false },
    member: {
      roles: {
        cache: new Map([['role_member_biasa', { id: 'role_member_biasa' }]]),
      },
    },
  };

  assert.strictEqual(hasCommandAccess(mockAllowedInteraction), true, 'Role yang diizinkan harus bisa memakai command');
  assert.strictEqual(hasCommandAccess(mockBlockedInteraction), false, 'Role biasa harus ditolak memakai command');

  removeCommandRole(testGuildId, 'role_allowed_cmd');
  console.log('✅ [LULUS] Proteksi akses command khusus Role yang diizinkan (/command-role) berfungsi akurat.');
}

// 5b. Uji Parser Prefix Command (gstatus, gmonitor, dll vs chat biasa)
{
  const cmd1 = parsePrefixCommand('gstatus', 'g');
  assert.deepStrictEqual(cmd1, { command: 'status', args: [] });

  const cmd2 = parsePrefixCommand('GMonitor 7days', 'g');
  assert.deepStrictEqual(cmd2, { command: 'monitor', args: ['7days'] });

  const normalChat = parsePrefixCommand('gimana kabar kalian semua hari ini', 'g');
  assert.strictEqual(normalChat, null, 'Chat biasa berawalan g tidak boleh dianggap command');

  const spacedPrefix = parsePrefixCommand('g status', 'g');
  assert.strictEqual(spacedPrefix, null, 'Spasi setelah g tidak boleh dianggap command');
  console.log('✅ [LULUS] Parser Prefix Command (gstatus, gmonitor, dll) berfungsi akurat.');
}

// 6. Uji Database SQLite, Target Harian (100 pesan/hari), Bukti Log, & Export CSV (Tanpa Server Log Diset)
{
  const testGuildId = 'test_guild_999';
  const testUserId = 'user_admin_1';

  setSetting('daily_target', 100);
  setSetting('min_words', 4);
  setSetting('log_channel_id', ''); // Simulasi server log belum diset

  const cfg = getConfig();
  assert.strictEqual(cfg.dailyTarget, 100);
  assert.strictEqual(cfg.logChannelId, '');

  addTrackedRole(testGuildId, 'role_staff_1', 'Staff Server');
  addTrackedChannel(testGuildId, 'chan_general_1', 'general-chat');

  assert.strictEqual(getTrackedRoles(testGuildId).length, 1);
  assert.strictEqual(getTrackedChannels(testGuildId).length, 1);

  // Simulasikan 2 pesan valid
  recordMessageLog({
    messageId: 'msg_001',
    guildId: testGuildId,
    channelId: 'chan_general_1',
    channelName: 'general-chat',
    userId: testUserId,
    userTag: 'admin1#0001',
    content: 'halo semuanya selamat malam lagi pada ngapain nih',
    wordCount: 8,
    messageUrl: 'https://discord.com/channels/test_guild_999/chan_general_1/msg_001',
    createdAt: Date.now() - 5000,
  });

  const rec2 = recordMessageLog({
    messageId: 'msg_002',
    guildId: testGuildId,
    channelId: 'chan_general_1',
    channelName: 'general-chat',
    userId: testUserId,
    userTag: 'admin1#0001',
    content: 'jangan lupa ikut event mabar nanti malam jam delapan ya',
    wordCount: 10,
    messageUrl: 'https://discord.com/channels/test_guild_999/chan_general_1/msg_002',
    createdAt: Date.now(),
  });

  assert.strictEqual(rec2.dailyCount, 2);
  assert.strictEqual(rec2.dailyWords, 18);

  const last = getLastUserMessage(testGuildId, testUserId);
  assert.ok(last.content.includes('jangan lupa ikut event'));

  const stats = getUserStats(testGuildId, testUserId);
  assert.strictEqual(stats.dailyCount, 2);
  assert.strictEqual(stats.recentLogs.length, 2);

  const mon = getMonitorData(testGuildId, 'today');
  assert.strictEqual(mon.length, 1);
  assert.strictEqual(Number(mon[0].message_count), 2);

  // Uji Konsistensi Mingguan (completed_days) & Anti-Monolog Config
  setSetting('daily_target', 2); // sementara set target 2 untuk menguji completed_days
  setSetting('cooldown_seconds', 0);
  setSetting('max_consecutive', 4);
  const updatedCfg = getConfig();
  assert.strictEqual(updatedCfg.cooldownSeconds, 0);
  assert.strictEqual(updatedCfg.maxConsecutive, 4);

  const statsTargetMet = getUserStats(testGuildId, testUserId);
  assert.strictEqual(statsTargetMet.weeklyCompletedDays, 1, 'Harus mencatat 1 hari tuntas di minggu ini');

  const mon7Days = getMonitorData(testGuildId, '7days');
  assert.strictEqual(Number(mon7Days[0].completed_days), 1, 'Monitor 7 hari harus menampilkan completed_days = 1');

  setSetting('daily_target', 100);
  setSetting('cooldown_seconds', 5);
  setSetting('max_consecutive', 3);

  // Uji Edit & Hapus Pesan (Anti-Curang)
  const updated = updateMessageLogById('msg_002', 'jangan lupa ikut event mabar nanti malam ya', 8);
  assert.strictEqual(updated.dailyWords, 16);

  const removed = removeMessageLogById('msg_001');
  assert.strictEqual(removed.dailyCount, 1);

  const logs = getMessageLogs({ guildId: testGuildId });
  const csv = generateLogsCsv(logs, cfg.dailyTarget);
  assert.ok(csv.includes('https://discord.com/channels/test_guild_999/chan_general_1/msg_002'));

  const bar = buildProgressBar(50, 100, 10);
  assert.ok(bar.includes('**50/100** (50%)'));

  // 7. Uji Laporan Tutup Buku Harian & Auto-Reminder Malam Hari
  (async () => {
    const recap = await buildDailyRecapPayload(null, testGuildId, rec2.dateWib);
    assert.strictEqual(recap.embeds.length, 1);
    assert.strictEqual(recap.files.length, 1, 'Harus menyertakan file CSV bukti log');

    const reminder = await buildNightReminderPayload(null, testGuildId, rec2.dateWib);
    assert.ok(reminder && reminder.content.includes(`<@${testUserId}>`), 'Harus me-mention user yang belum capai target');

    // Bersihkan data uji
    resetLogs({ guildId: testGuildId, scope: 'all' });
    dbCleanup(testGuildId);
    console.log('✅ [LULUS] Database SQLite, Target Harian (100/hari), Monitor, Anti-Curang Hapus/Edit, Bukti Log, & Export CSV berfungsi sempurna!');
    console.log('✅ [LULUS] Fitur Laporan Tutup Buku Otomatis (00:00 WIB + CSV) & Auto-Reminder Malam Hari berfungsi sempurna!');
    console.log('\n🎉 SEMUA PENGUJIAN BERHASIL LULUS TANPA ERROR!');
  })();
}

function dbCleanup(guildId) {
  const { db } = require('./database');
  db.prepare('DELETE FROM tracked_roles WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM tracked_channels WHERE guild_id = ?').run(guildId);
}
