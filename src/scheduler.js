const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const {
  getConfig,
  getSetting,
  setSetting,
  getDateWIB,
  getYesterdayDateWIB,
  getTimePartsWIB,
  getTrackedRoles,
  getTrackedUsers,
  getMonitorData,
  getMessageLogs,
} = require('./database');
const { THEME, DIVIDER, buildProgressBar, generateLogsCsv, joinLinesWithinLimit } = require('./utils');

const memberFetchCooldown = new Map();
const MEMBER_FETCH_TTL_MS = 5 * 60 * 1000;

async function fetchGuildMembersCached(guildObj) {
  if (!guildObj) return;
  const lastFetched = memberFetchCooldown.get(guildObj.id) || 0;
  const needsFetch =
    guildObj.members.cache.size < (guildObj.memberCount || 0) &&
    Date.now() - lastFetched > MEMBER_FETCH_TTL_MS;
  if (needsFetch) {
    memberFetchCooldown.set(guildObj.id, Date.now());
    await guildObj.members.fetch().catch(() => null);
  }
}

/**
 * Mengumpulkan daftar seluruh anggota yang dipantau pada tanggal tertentu
 * (termasuk yang masih 0 pesan dari Role Target & User Target)
 */
async function collectGuildTargetStatus(client, guildId, dateWib) {
  const cfg = getConfig();
  const rows = getMonitorData(guildId, 'today', dateWib);

  const combinedMap = new Map();
  for (const r of rows) {
    combinedMap.set(r.user_id, {
      user_id: r.user_id,
      user_tag: r.user_tag,
      message_count: Number(r.message_count),
      total_words: Number(r.total_words),
    });
  }

  const trackedUsers = getTrackedUsers(guildId);
  for (const u of trackedUsers) {
    if (!combinedMap.has(u.user_id)) {
      combinedMap.set(u.user_id, {
        user_id: u.user_id,
        user_tag: u.username,
        message_count: 0,
        total_words: 0,
      });
    }
  }

  const trackedRoles = getTrackedRoles(guildId);
  const guildObj = client?.guilds?.cache?.get(guildId);
  if (guildObj && trackedRoles.length > 0) {
    await fetchGuildMembersCached(guildObj);
    for (const [, member] of guildObj.members.cache) {
      if (member.user.bot) continue;
      const hasTargetRole = trackedRoles.some((tr) => member.roles.cache.has(tr.role_id));
      if (hasTargetRole && !combinedMap.has(member.id)) {
        combinedMap.set(member.id, {
          user_id: member.id,
          user_tag: member.user.tag,
          message_count: 0,
          total_words: 0,
        });
      }
    }
  }

  const all = Array.from(combinedMap.values()).sort(
    (a, b) => b.message_count - a.message_count || b.total_words - a.total_words
  );

  const completed = all.filter((m) => m.message_count >= cfg.dailyTarget);
  const inProgress = all.filter((m) => m.message_count > 0 && m.message_count < cfg.dailyTarget);
  const zero = all.filter((m) => m.message_count === 0);

  return {
    all,
    completed,
    inProgress,
    zero,
    totalMessages: all.reduce((s, m) => s + m.message_count, 0),
    totalWords: all.reduce((s, m) => s + m.total_words, 0),
  };
}

/**
 * Membangun payload Laporan Tutup Buku Harian (Embed + File CSV Bukti Log)
 */
async function buildDailyRecapPayload(client, guildId, targetDateWib) {
  const cfg = getConfig();
  const statusData = await collectGuildTargetStatus(client, guildId, targetDateWib);
  const { all, completed, inProgress, zero, totalMessages, totalWords } = statusData;

  const formatCompleted = completed.length
    ? joinLinesWithinLimit(
        completed.map(
          (m, i) => `\`${i + 1}.\` <@${m.user_id}> — **${m.message_count}/${cfg.dailyTarget} pesan** (\`${m.total_words} kata\`)`
        ),
        1024
      )
    : '> *Tidak ada anggota yang mencapai target penuh.*';

  const formatInProgress = inProgress.length
    ? joinLinesWithinLimit(
        inProgress.map((m, i) => {
          const kurang = cfg.dailyTarget - m.message_count;
          return `\`${i + 1}.\` <@${m.user_id}> — **${m.message_count}/${cfg.dailyTarget} pesan** *(Kurang ${kurang} pesan)*`;
        }),
        1024
      )
    : '> *Tidak ada.*';

  const formatZero = zero.length
    ? joinLinesWithinLimit(
        zero.map((m, i) => `\`${i + 1}.\` <@${m.user_id}> (**${m.user_tag}**) — \`0 pesan\``),
        1024
      )
    : '> *Tidak ada (Semua anggota aktif).*';

  const embed = new EmbedBuilder()
    .setAuthor({
      name: 'Laporan Tutup Buku Otomatis • General Chat Tracker',
      iconURL: client?.user?.displayAvatarURL(),
    })
    .setTitle(`📑 Rekapitulasi Tutup Buku Harian — ${targetDateWib}`)
    .setColor(completed.length === all.length && all.length > 0 ? THEME.SUCCESS : THEME.PRIMARY)
    .setDescription(
      `\`\`\`yaml\n` +
      `Tanggal Rekap   : ${targetDateWib} (00:00 WIB)\n` +
      `Target Harian   : ${cfg.dailyTarget} Pesan / Hari (Min. ${cfg.minWords} Kata)\n` +
      `Ringkasan Hasil : ${completed.length} Tuntas | ${inProgress.length} Kurang | ${zero.length} Pasif (0 Pesan)\n` +
      `Total Aktivitas : ${totalMessages} Pesan Valid (${totalWords} Kata)\n` +
      `\`\`\`\n${DIVIDER}`
    )
    .addFields(
      {
        name: `✅ Tuntas Target (${completed.length})`,
        value: formatCompleted.slice(0, 1024),
        inline: false,
      },
      {
        name: `⏳ Belum Tuntas / Kurang (${inProgress.length})`,
        value: formatInProgress.slice(0, 1024),
        inline: false,
      },
      {
        name: `💤 Tidak Aktif / 0 Pesan (${zero.length})`,
        value: formatZero.slice(0, 1024),
        inline: false,
      }
    )
    .setFooter({ text: 'File CSV bukti log lengkap terlampir pada laporan ini' })
    .setTimestamp();

  const logs = getMessageLogs({
    guildId,
    dateWib: targetDateWib,
    limit: 5000,
  });

  const files = [];
  if (logs.length > 0) {
    const csvContent = generateLogsCsv(logs, cfg.dailyTarget);
    const attachment = new AttachmentBuilder(Buffer.from(csvContent, 'utf-8'), {
      name: `tutup-buku-${targetDateWib}.csv`,
    });
    files.push(attachment);
  }

  return { embeds: [embed], files };
}

/**
 * Membangun payload Auto-Reminder Malam Hari untuk anggota yang belum mencapai target
 */
async function buildNightReminderPayload(client, guildId, dateWib = getDateWIB()) {
  const cfg = getConfig();
  const statusData = await collectGuildTargetStatus(client, guildId, dateWib);
  const { all, completed, inProgress, zero } = statusData;
  const incomplete = [...inProgress, ...zero];

  if (all.length === 0) {
    return null;
  }

  if (incomplete.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle(`🎉 Pengingat Malam (${dateWib}) — Semua Target Tuntas!`)
      .setColor(THEME.SUCCESS)
      .setDescription(
        `Seluruh **${completed.length} anggota** yang dipantau telah menyelesaikan target **${cfg.dailyTarget} pesan/hari** sebelum batas waktu pukul \`00:00 WIB\`.`
      )
      .setTimestamp();
    return { embeds: [embed] };
  }

  const lines = incomplete.slice(0, 25).map((m, idx) => {
    const rem = Math.max(0, cfg.dailyTarget - m.message_count);
    const bar = buildProgressBar(m.message_count, cfg.dailyTarget, 8);
    return `\`${String(idx + 1).padStart(2, '0')}.\` <@${m.user_id}> — ${bar} *(Kurang **${rem}** pesan)*`;
  });

  const headerText =
    `\`\`\`yaml\n` +
    `Target Harian  : ${cfg.dailyTarget} Pesan Valid (Min. ${cfg.minWords} Kata)\n` +
    `Batas Waktu    : Pukul 23:59 WIB Malam Ini\n` +
    `Status Saat Ini: ${completed.length} Sudah Tuntas | ${incomplete.length} Belum Tuntas\n` +
    `\`\`\`\n` +
    `${DIVIDER}\n` +
    `**📋 Daftar Anggota yang Belum Mencapai Target (${incomplete.length} Orang):**\n\n`;

  const bodyText = joinLinesWithinLimit(lines, 4096 - headerText.length);

  const mentionPrefix = '🔔 **Pengingat Target Harian General Chat:** ';
  const mentions = joinLinesWithinLimit(
    incomplete.map((m) => `<@${m.user_id}>`),
    2000 - mentionPrefix.length,
    ' ',
    ' ...'
  );

  const embed = new EmbedBuilder()
    .setAuthor({
      name: 'Auto-Reminder Target Harian • General Chat Tracker',
      iconURL: client?.user?.displayAvatarURL(),
    })
    .setTitle(`⏰ Pengingat Target General Chat (${dateWib} WIB)`)
    .setColor(THEME.WARNING)
    .setDescription(headerText + bodyText)
    .setFooter({ text: 'Segera ramaikan General Chat sebelum tutup buku otomatis pukul 00:00 WIB!' })
    .setTimestamp();

  return {
    content: `${mentionPrefix}${mentions}`,
    embeds: [embed],
  };
}

/**
 * Menjalankan penjadwal otomatis (Tutup Buku 00:00 WIB & Auto-Reminder Malam)
 */
function startScheduler(client) {
  // Set nilai awal last_recap_date jika baru pertama kali dijalankan agar tidak langsung kirim rekap kosong
  if (!getSetting('last_recap_date')) {
    setSetting('last_recap_date', getYesterdayDateWIB());
  }

  let isRunning = false;

  const checkSchedule = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      const cfg = getConfig();
      const targetGuildId = cfg.mainGuildId || client.guilds.cache.first()?.id;
      if (!targetGuildId) return;

      const { dateWib: todayWib, hour } = getTimePartsWIB();
      const yesterdayWib = getYesterdayDateWIB();

      // 1. Cek Laporan Tutup Buku Harian Otomatis (Setelah 00:00 WIB pergantian hari)
      const lastRecapDate = getSetting('last_recap_date', '');
      if (cfg.autoRecap && cfg.logChannelId && lastRecapDate !== yesterdayWib) {
        const logChannel = await client.channels.fetch(cfg.logChannelId).catch(() => null);
        if (logChannel && logChannel.isTextBased()) {
          const payload = await buildDailyRecapPayload(client, targetGuildId, yesterdayWib);
          const sent = await logChannel.send(payload).catch((err) => {
            console.warn('⚠️ Gagal mengirim Laporan Tutup Buku Harian:', err.message);
            return null;
          });
          if (sent) {
            setSetting('last_recap_date', yesterdayWib);
            console.log(`✅ [Scheduler] Laporan Tutup Buku Harian (${yesterdayWib}) berhasil dikirim.`);
          }
        }
      }

      // 2. Cek Auto-Reminder Malam Hari (Pada jam yang ditentukan, misal 20:00 WIB)
      const lastReminderDate = getSetting('last_reminder_date', '');
      const reminderTargetChanId = cfg.reminderChannelId || cfg.logChannelId;
      if (
        cfg.reminderEnabled &&
        reminderTargetChanId &&
        hour >= cfg.reminderHour &&
        lastReminderDate !== todayWib
      ) {
        const remChannel = await client.channels.fetch(reminderTargetChanId).catch(() => null);
        if (remChannel && remChannel.isTextBased()) {
          const payload = await buildNightReminderPayload(client, targetGuildId, todayWib);
          if (payload) {
            const sent = await remChannel.send(payload).catch((err) => {
              console.warn('⚠️ Gagal mengirim Auto-Reminder Malam:', err.message);
              return null;
            });
            if (sent) {
              setSetting('last_reminder_date', todayWib);
              console.log(`✅ [Scheduler] Auto-Reminder Malam (${todayWib}) berhasil dikirim.`);
            }
          } else {
            setSetting('last_reminder_date', todayWib);
          }
        }
      }
    } catch (error) {
      console.error('❌ Error pada Scheduler:', error);
    } finally {
      isRunning = false;
    }
  };

  // Cek setiap 30 detik
  const timer = setInterval(checkSchedule, 30 * 1000);
  timer.unref?.();
  return timer;
}

module.exports = {
  fetchGuildMembersCached,
  collectGuildTargetStatus,
  buildDailyRecapPayload,
  buildNightReminderPayload,
  startScheduler,
};

