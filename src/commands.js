const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

const {
  getDateWIB,
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
  getUserStats,
  getMonitorData,
  getMessageLogs,
  resetLogs,
} = require('./database');

const {
  THEME,
  DIVIDER,
  getProgressStatus,
  buildProgressBar,
  generateLogsCsv,
  formatSnippet,
  joinLinesWithinLimit,
} = require('./utils');

const {
  fetchGuildMembersCached,
  buildDailyRecapPayload,
  buildNightReminderPayload,
} = require('./scheduler');

function isValidDateString(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

/**
 * Mengecek apakah pengguna adalah Admin Server atau Owner Bot (Akses Penuh Konfigurasi)
 */
function isAdminOrOwner(ctx) {
  const ownerIds = (process.env.OWNER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const userId = ctx.user?.id || ctx.author?.id;
  const perms = ctx.memberPermissions || ctx.member?.permissions;

  if (userId && ownerIds.includes(userId)) return true;
  if (perms?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (perms?.has(PermissionFlagsBits.Administrator)) return true;
  return false;
}

/**
 * Mengecek apakah pengguna memiliki Role yang Diizinkan untuk menggunakan command bot.
 * - Admin / Owner selalu diizinkan.
 * - Jika daftar /command-role sudah diatur di server ini, maka HANYA role di daftar tersebut yang diizinkan.
 * - Jika /command-role belum diatur, otomatis mengizinkan role yang ada di /target-role.
 * - Member biasa tanpa role yang diizinkan akan ditolak sepenuhnya.
 */
function hasCommandAccess(interaction) {
  if (isAdminOrOwner(interaction)) return true;

  const rolesProp = interaction.member?.roles;
  if (!rolesProp) return false;

  const hasRole = (roleId) =>
    Array.isArray(rolesProp) ? rolesProp.includes(roleId) : Boolean(rolesProp.cache?.has(roleId));

  const allowedCmdRoles = getCommandRoles(interaction.guildId);
  if (allowedCmdRoles.length > 0) {
    return allowedCmdRoles.some((r) => hasRole(r.role_id));
  }

  // Fallback: jika /command-role belum diatur khusus, cek apakah punya role yang dilacak (/target-role)
  const trackedRoles = getTrackedRoles(interaction.guildId);
  if (trackedRoles.length > 0) {
    return trackedRoles.some((r) => hasRole(r.role_id));
  }

  return false;
}

/**
 * Menentukan ID Server Utama yang sedang dikelola/dipantau.
 */
function resolveTargetGuildId(interaction) {
  const config = getConfig();
  return config.mainGuildId || interaction.guildId;
}

/**
 * Membuat Embed Penolakan Akses yang rapi & modern
 */
function buildAccessDeniedEmbed(reason, allowedRoles = []) {
  const roleMentions = allowedRoles.length
    ? allowedRoles.map((r) => `<@&${r.role_id}>`).join(', ')
    : '*Hanya Administrator / Role yang Diizinkan*';

  return new EmbedBuilder()
    .setColor(THEME.DANGER)
    .setTitle('🔒 Akses Command Dibatasi')
    .setDescription(
      `${reason}\n\n` +
      `> 🛡️ **Role yang Diizinkan:** ${roleMentions}`
    )
    .setFooter({ text: 'General Chat Tracker • Sistem Keamanan Akses Role' })
    .setTimestamp();
}

/**
 * Membangun Embed & Tombol Interaktif untuk /stats
 */
function buildStatsPayload(targetUser, targetGuildId, dateInput) {
  const cfg = getConfig();
  const stats = getUserStats(targetGuildId, targetUser.id, dateInput);
  const status = getProgressStatus(stats.dailyCount, cfg.dailyTarget);
  const progressBar = buildProgressBar(stats.dailyCount, cfg.dailyTarget, 12);
  const remaining = Math.max(0, cfg.dailyTarget - stats.dailyCount);

  const recentProofText = stats.recentLogs.length
    ? joinLinesWithinLimit(
        stats.recentLogs.map((log, idx) => {
          const snippet = formatSnippet(log.content, 50);
          const timeSec = Math.floor(log.created_at / 1000);
          return `\`#${idx + 1}\` <t:${timeSec}:t> di **#${log.channel_name}** • \`${log.word_count} kata\`\n└ *"${snippet}"* — **[🔗 Lihat Bukti](${log.message_url})**`;
        }),
        1024,
        '\n\n'
      )
    : '> *Belum ada pesan valid yang tercatat untuk user ini.*';

  const embed = new EmbedBuilder()
    .setAuthor({
      name: ` Rapor Keaktifan General Chat`,
      iconURL: targetUser.displayAvatarURL(),
    })
    .setTitle(`👤 ${targetUser.username} (${targetUser.tag})`)
    .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
    .setColor(status.color)
    .setDescription(
      `\`\`\`yaml\n` +
      `Status Hari Ini : ${status.label}\n` +
      `Tanggal Pantau  : ${dateInput} (WIB)\n` +
      `Syarat Valid    : Minimal ${cfg.minWords} Kata / Pesan\n` +
      `\`\`\`\n` +
      `**🎯 Progress Target Harian (${cfg.dailyTarget} Pesan/Hari)**\n` +
      `> ${progressBar}\n` +
      `> ${remaining === 0
        ? '🎉 **Luar biasa! Target harian telah terpenuhi!**'
        : `📌 Kurang **${remaining} pesan valid** lagi untuk mencapai target hari ini.`
      }`
    )
    .addFields(
      {
        name: '📅 Hari Ini',
        value: `\`\`\`ini\n[${stats.dailyCount} Pesan]\n${stats.dailyWords} Kata\n\`\`\``,
        inline: true,
      },
      {
        name: '📆 7 Hari Terakhir',
        value: `\`\`\`ini\n[${stats.weeklyCount} Pesan]\n${stats.weeklyWords} Kata • ${stats.weeklyCompletedDays}/7 Hari Tuntas\n\`\`\``,
        inline: true,
      },
      {
        name: '🏆 Total Semua Waktu',
        value: `\`\`\`ini\n[${stats.totalCount} Pesan]\nRata2 ${stats.avgWords} Kata\n\`\`\``,
        inline: true,
      },
      {
        name: `${DIVIDER}\n📋 5 Bukti Log Pesan Terakhir`,
        value: recentProofText,
        inline: false,
      }
    )
    .setFooter({
      text: `ID User: ${targetUser.id} • Klik tombol di bawah untuk memperbarui data`,
    })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`stats_refresh:${targetUser.id}:${dateInput}`)
      .setLabel('Refresh Statistik')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`stats_logs:${targetUser.id}:${dateInput}`)
      .setLabel('Lihat Bukti Log Lengkap')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Membangun Embed & Tombol Filter Interaktif untuk /monitor (Monitoring Kebutuhan Internal)
 */
async function buildMonitorPayload(client, targetGuildId, period = 'today', dateInput = getDateWIB()) {
  const cfg = getConfig();
  const rows = getMonitorData(targetGuildId, period, dateInput);

  // Untuk monitoring Hari Ini & 7 Hari Terakhir, gabungkan juga user/role yang dilacak tapi masih 0 pesan agar evaluasi lengkap
  const combinedMap = new Map();
  for (const r of rows) {
    combinedMap.set(r.user_id, {
      user_id: r.user_id,
      user_tag: r.user_tag,
      message_count: Number(r.message_count),
      total_words: Number(r.total_words),
      active_days: Number(r.active_days || 1),
      completed_days: Number(r.completed_days || 0),
    });
  }

  if (period === 'today' || period === '7days') {
    const trackedUsers = getTrackedUsers(targetGuildId);
    for (const u of trackedUsers) {
      if (!combinedMap.has(u.user_id)) {
        combinedMap.set(u.user_id, {
          user_id: u.user_id,
          user_tag: u.username,
          message_count: 0,
          total_words: 0,
          active_days: 0,
          completed_days: 0,
        });
      }
    }

    const trackedRoles = getTrackedRoles(targetGuildId);
    const guildObj = client?.guilds?.cache?.get(targetGuildId);
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
            active_days: 0,
            completed_days: 0,
          });
        }
      }
    }
  }

  const monitorList = Array.from(combinedMap.values()).sort((a, b) => {
    if (period !== 'today' && b.completed_days !== a.completed_days) {
      return b.completed_days - a.completed_days;
    }
    return b.message_count - a.message_count || b.total_words - a.total_words;
  });

  const periodLabels = {
    today: `Hari Ini (${dateInput} WIB)`,
    '7days': '7 Hari Terakhir',
    month: `Bulan Ini (${dateInput.slice(0, 7)})`,
    all: 'Semua Waktu (All-Time)',
  };

  const completedCount = monitorList.filter((r) => r.message_count >= cfg.dailyTarget).length;
  const inProgressCount = monitorList.filter((r) => r.message_count > 0 && r.message_count < cfg.dailyTarget).length;
  const zeroCount = monitorList.filter((r) => r.message_count === 0).length;
  const totalMessages = monitorList.reduce((acc, r) => acc + r.message_count, 0);
  const totalWords = monitorList.reduce((acc, r) => acc + r.total_words, 0);

  const summaryHeader =
    period === 'today'
      ? `\`\`\`yaml\n` +
      `Periode Monitor : ${periodLabels[period]}\n` +
      `Target Harian   : ${cfg.dailyTarget} Pesan / Hari (Min. ${cfg.minWords} Kata)\n` +
      `Status Anggota  : ${completedCount} Tuntas | ${inProgressCount} Berjalan | ${zeroCount} Belum Aktif\n` +
      `Total Aktivitas : ${totalMessages} Pesan Valid (${totalWords} Kata)\n` +
      `\`\`\``
      : `\`\`\`yaml\n` +
      `Periode Monitor : ${periodLabels[period]}\n` +
      `Anggota Tercatat: ${monitorList.length} Orang\n` +
      `Total Aktivitas : ${totalMessages} Pesan Valid (${totalWords} Kata)\n` +
      `\`\`\``;

  const prefixText = `${summaryHeader}\n${DIVIDER}\n\n`;
  let bodyText = '';
  if (!monitorList.length) {
    bodyText = `> 📭 *Belum ada data aktivitas atau anggota yang tercatat pada periode **${periodLabels[period]}**.*`;
  } else {
    const formattedLines = monitorList.slice(0, 25).map((row, idx) => {
      const num = `\`${String(idx + 1).padStart(2, '0')}.\``;
      const count = row.message_count;
      const words = row.total_words;

      if (period === 'today') {
        const bar = buildProgressBar(count, cfg.dailyTarget, 10);
        const rem = Math.max(0, cfg.dailyTarget - count);
        const note = count >= cfg.dailyTarget ? 'Tuntas' : count === 0 ? 'Belum Chat' : `-${rem} lagi`;
        return `${num} <@${row.user_id}> (**${row.user_tag}**)\n┗ ${bar} • \`${words} kata\` • *(${note})*`;
      } else {
        const days = row.active_days || 0;
        const comp = row.completed_days || 0;
        const tuntasLabel = period === '7days' ? `${comp}/7 hari` : `${comp} hari`;
        return `${num} <@${row.user_id}> (**${row.user_tag}**)\n┗ 🎯 Tuntas: **${tuntasLabel}** • 💬 **${count} pesan** • 📝 \`${words} kata\` • 🗓️ \`${days} hari aktif\``;
      }
    });
    bodyText = joinLinesWithinLimit(formattedLines, 4096 - prefixText.length, '\n\n');
  }

  const embed = new EmbedBuilder()
    .setTitle(`📡 Panel Monitoring Target General Chat`)
    .setColor(period === 'today' && completedCount > 0 ? THEME.SUCCESS : THEME.PRIMARY)
    .setDescription(`${prefixText}${bodyText}`)
    .setFooter({
      text: `Monitoring Internal • Gunakan tombol di bawah untuk mengganti rentang waktu`,
    })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mon_period:today:${dateInput}`)
      .setLabel('Hari Ini')
      .setEmoji('📅')
      .setStyle(period === 'today' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mon_period:7days:${dateInput}`)
      .setLabel('7 Hari')
      .setEmoji('📆')
      .setStyle(period === '7days' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mon_period:month:${dateInput}`)
      .setLabel('Bulan Ini')
      .setEmoji('🗓️')
      .setStyle(period === 'month' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mon_period:all:${dateInput}`)
      .setLabel('Semua Waktu')
      .setEmoji('📊')
      .setStyle(period === 'all' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mon_refresh:${period}:${dateInput}`)
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Success)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mon_send_reminder:${dateInput}`)
      .setLabel('Kirim Reminder Sekarang')
      .setEmoji('⏰')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mon_send_recap:${dateInput}`)
      .setLabel(`Laporan Tutup Buku (${dateInput})`)
      .setEmoji('📑')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

const commandDefinitions = [
  // 1. /config
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Kelola pengaturan sistem General Chat Tracker')
    .addSubcommand((sub) =>
      sub.setName('view').setDescription('Lihat dashboard konfigurasi tracker yang sedang aktif')
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-main-server')
        .setDescription('Tetapkan server utama tempat General Chat dilacak')
        .addStringOption((opt) =>
          opt
            .setName('guild_id')
            .setDescription('ID Server Utama (kosongkan untuk menggunakan server ini)')
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-log-channel')
        .setDescription('Tetapkan channel pengiriman bukti log (bisa di server khusus log)')
        .addStringOption((opt) =>
          opt
            .setName('channel_id')
            .setDescription('ID Channel Log (kosongkan untuk channel ini, atau ketik "off" untuk mematikan)')
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('daily-target')
        .setDescription('Atur target jumlah pesan harian per orang (contoh: 100 pesan/hari)')
        .addIntegerOption((opt) =>
          opt
            .setName('jumlah')
            .setDescription('Target pesan per hari (contoh: 100)')
            .setMinValue(1)
            .setMaxValue(10000)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('min-words')
        .setDescription('Atur minimal jumlah kata agar pesan dihitung (default: 4 kata)')
        .addIntegerOption((opt) =>
          opt
            .setName('jumlah')
            .setDescription('Minimal kata per pesan (default: 4)')
            .setMinValue(1)
            .setMaxValue(100)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('auto-recap')
        .setDescription('Atur Laporan Tutup Buku Harian Otomatis setiap jam 00:00 WIB ke Server Log')
        .addStringOption((opt) =>
          opt
            .setName('status')
            .setDescription('Aktifkan atau matikan laporan tutup buku otomatis')
            .setRequired(true)
            .addChoices(
              { name: 'Aktifkan (Kirim Rekap & CSV tiap 00:00 WIB)', value: 'on' },
              { name: 'Matikan', value: 'off' }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('reminder')
        .setDescription('Atur Pengingat Malam Otomatis (Auto-Reminder) untuk yang belum capai target')
        .addStringOption((opt) =>
          opt
            .setName('status')
            .setDescription('Aktifkan atau matikan pengingat otomatis')
            .setRequired(true)
            .addChoices(
              { name: 'Aktifkan', value: 'on' },
              { name: 'Matikan', value: 'off' }
            )
        )
        .addIntegerOption((opt) =>
          opt
            .setName('jam')
            .setDescription('Jam pengiriman dalam WIB (0-23, default: 20 untuk pukul 20:00 WIB)')
            .setMinValue(0)
            .setMaxValue(23)
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName('channel_id')
            .setDescription('ID Channel tempat reminder dikirim (kosongkan agar dikirim ke Channel Log)')
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('anti-monolog')
        .setDescription('Atur jeda cooldown & batas chat beruntun sendirian (cegah kejar setoran)')
        .addIntegerOption((opt) =>
          opt
            .setName('cooldown_detik')
            .setDescription('Jeda minimal antar pesan dari user sama (detik, 0 untuk matikan, default: 5)')
            .setMinValue(0)
            .setMaxValue(300)
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('max_beruntun')
            .setDescription('Batas maksimal chat beruntun tanpa diselingi orang lain (0 untuk matikan, default: 3)')
            .setMinValue(0)
            .setMaxValue(50)
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('prefix')
        .setDescription('Atur awalan prefix command teks (contoh: g -> gstatus, gmonitor)')
        .addStringOption((opt) =>
          opt
            .setName('teks')
            .setDescription('Prefix baru (maksimal 5 karakter, default: g)')
            .setMinLength(1)
            .setMaxLength(5)
            .setRequired(true)
        )
    ),

  // 2. /command-role (Role yang diizinkan memakai command bot)
  new SlashCommandBuilder()
    .setName('command-role')
    .setDescription('Atur role mana saja yang diizinkan menggunakan command bot ini')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Izinkan sebuah role untuk menggunakan command bot')
        .addRoleOption((opt) =>
          opt.setName('role').setDescription('Pilih role yang diizinkan').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Cabut izin penggunaan command dari sebuah role')
        .addRoleOption((opt) =>
          opt.setName('role').setDescription('Pilih role yang ingin dicabut aksesnya').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('Lihat daftar role yang diizinkan menggunakan command bot')
    ),

  // 3. /target-role
  new SlashCommandBuilder()
    .setName('target-role')
    .setDescription('Atur role mana saja yang dilacak pesannya oleh bot di General Chat')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Tambahkan role ke dalam daftar pelacakan chat')
        .addRoleOption((opt) =>
          opt.setName('role').setDescription('Pilih role yang akan dilacak').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Hapus role dari daftar pelacakan chat')
        .addRoleOption((opt) =>
          opt.setName('role').setDescription('Pilih role yang ingin dihapus').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('Lihat daftar role yang sedang dilacak pesannya')
    ),

  // 4. /target-user
  new SlashCommandBuilder()
    .setName('target-user')
    .setDescription('Atur user/orang spesifik yang dilacak pesannya oleh bot')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Tambahkan user spesifik ke dalam daftar pelacakan')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('Pilih user yang akan dilacak').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Hapus user spesifik dari daftar pelacakan')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('Pilih user yang ingin dihapus').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('Lihat daftar user spesifik yang sedang dilacak')
    ),

  // 5. /channel
  new SlashCommandBuilder()
    .setName('channel')
    .setDescription('Atur channel General Chat mana saja yang dilacak')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Tambahkan channel yang akan dilacak (contoh: #general-chat)')
        .addChannelOption((opt) =>
          opt.setName('channel').setDescription('Pilih channel teks').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Hapus channel dari daftar pelacakan')
        .addChannelOption((opt) =>
          opt.setName('channel').setDescription('Pilih channel yang ingin dihapus').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('Lihat daftar channel yang sedang dilacak')
    ),

  // 6. /stats
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Cek rapor keaktifan, progress target harian, dan bukti pesan')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('Pilih user (kosongkan untuk melihat statistik diri sendiri)').setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('tanggal')
        .setDescription('Format YYYY-MM-DD (kosongkan untuk hari ini WIB)')
        .setRequired(false)
    ),

  // 7. /monitor
  new SlashCommandBuilder()
    .setName('monitor')
    .setDescription('Pantau ketuntasan target & keaktifan General Chat secara internal')
    .addStringOption((opt) =>
      opt
        .setName('periode')
        .setDescription('Pilih periode pemantauan')
        .setRequired(false)
        .addChoices(
          { name: 'Hari Ini (Progress Target Harian & Anggota Pasif)', value: 'today' },
          { name: '7 Hari Terakhir', value: '7days' },
          { name: 'Bulan Ini', value: 'month' },
          { name: 'Semua Waktu (All-Time)', value: 'all' }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName('tanggal')
        .setDescription('Khusus periode Hari Ini: cek tanggal tertentu (YYYY-MM-DD)')
        .setRequired(false)
    ),

  // 8. /logs
  new SlashCommandBuilder()
    .setName('logs')
    .setDescription('Lihat daftar bukti log pesan yang tercatat beserta link buktinya')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('Filter berdasarkan user tertentu').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('tanggal').setDescription('Filter tanggal format YYYY-MM-DD').setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('jumlah')
        .setDescription('Jumlah bukti log yang ditampilkan (1-20, default: 10)')
        .setMinValue(1)
        .setMaxValue(20)
        .setRequired(false)
    ),

  // 9. /export
  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Export bukti log pesan ke dalam file CSV (Excel / Spreadsheet)')
    .addStringOption((opt) =>
      opt.setName('tanggal').setDescription('Filter tanggal YYYY-MM-DD (kosongkan untuk semua tanggal)').setRequired(false)
    )
    .addUserOption((opt) =>
      opt.setName('user').setDescription('Filter user tertentu (kosongkan untuk semua user)').setRequired(false)
    ),

  // 10. /reset
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Reset data perhitungan pesan (Khusus Admin)')
    .addStringOption((opt) =>
      opt
        .setName('cakupan')
        .setDescription('Pilih cakupan data yang ingin direset')
        .setRequired(true)
        .addChoices(
          { name: 'Data Hari Ini Saja', value: 'today' },
          { name: 'User Tertentu Saja', value: 'user' },
          { name: 'Seluruh Data Log (Semua Waktu)', value: 'all' }
        )
    )
    .addUserOption((opt) =>
      opt.setName('user').setDescription('Wajib diisi jika memilih cakupan User Tertentu').setRequired(false)
    ),
];

async function handleInteraction(interaction, client) {
  // ==========================================================
  // A. PROTEKSI AKSES ROLE UNTUK SEMUA SLASH COMMAND & TOMBOL
  // ==========================================================
  if (interaction.isChatInputCommand() || interaction.isButton()) {
    if (!hasCommandAccess(interaction)) {
      const cmdRoles = getCommandRoles(interaction.guildId);
      const fallbackRoles = cmdRoles.length ? cmdRoles : getTrackedRoles(interaction.guildId);
      return interaction.reply({
        embeds: [
          buildAccessDeniedEmbed(
            'Maaf, perintah dan fitur interaktif bot ini **hanya dapat digunakan oleh Role yang diizinkan**.',
            fallbackRoles
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  // ==========================================================
  // B. HANDLER TOMBOL INTERAKTIF (BUTTONS)
  // ==========================================================
  if (interaction.isButton()) {
    const parts = interaction.customId.split(':');
    const action = parts[0];
    const targetGuildId = resolveTargetGuildId(interaction);

    if (action === 'mon_period' || action === 'mon_refresh') {
      const period = parts[1] || 'today';
      const dateInput = parts[2] || getDateWIB();
      await interaction.deferUpdate();
      const payload = await buildMonitorPayload(client, targetGuildId, period, dateInput);
      return interaction.editReply(payload);
    }

    if (action === 'mon_send_reminder') {
      const dateInput = parts[1] || getDateWIB();
      await interaction.deferReply();
      const payload = await buildNightReminderPayload(client, targetGuildId, dateInput);
      if (!payload) {
        return interaction.editReply({
          content: 'ℹ️ Belum ada anggota yang terdaftar di daftar pantauan.',
        });
      }
      return interaction.editReply(payload);
    }

    if (action === 'mon_send_recap') {
      const dateInput = parts[1] || getDateWIB();
      await interaction.deferReply();
      const payload = await buildDailyRecapPayload(client, targetGuildId, dateInput);
      return interaction.editReply(payload);
    }

    if (action === 'stats_refresh') {
      const userId = parts[1];
      const dateInput = parts[2] || getDateWIB();
      const targetUser = await client.users.fetch(userId).catch(() => interaction.user);
      const payload = buildStatsPayload(targetUser, targetGuildId, dateInput);
      return interaction.update(payload);
    }

    if (action === 'stats_logs') {
      const userId = parts[1];
      const dateInput = parts[2] || getDateWIB();
      const logs = getMessageLogs({
        guildId: targetGuildId,
        userId,
        dateWib: dateInput,
        limit: 10,
      });

      if (!logs.length) {
        return interaction.reply({
          content: `📭 Belum ada bukti log pesan untuk <@${userId}> pada tanggal **${dateInput}**.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const desc = joinLinesWithinLimit(
        logs.map((l, i) => {
          const snippet = formatSnippet(l.content, 65);
          const timeSec = Math.floor(l.created_at / 1000);
          return `\`#${i + 1}\` <t:${timeSec}:t> di **#${l.channel_name}** (\`${l.word_count} kata\`)\n┗ *"${snippet}"* — **[🔗 Buka Pesan](${l.message_url})**`;
        }),
        4096,
        '\n\n'
      );

      const logEmbed = new EmbedBuilder()
        .setTitle(`📋 Daftar Bukti Log Pesan (${dateInput})`)
        .setColor(THEME.INFO)
        .setDescription(desc)
        .setFooter({ text: `Menampilkan ${logs.length} bukti pesan terbaru` })
        .setTimestamp();

      return interaction.reply({
        embeds: [logEmbed],
        flags: MessageFlags.Ephemeral,
      });
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // Command pengaturan sistem tetap khusus Admin / Owner Server
  const adminOnlyCommands = ['config', 'command-role', 'target-role', 'target-user', 'channel', 'reset'];
  if (adminOnlyCommands.includes(commandName) && !isAdminOrOwner(interaction)) {
    return interaction.reply({
      embeds: [
        buildAccessDeniedEmbed(
          'Perintah konfigurasi ini hanya dapat dijalankan oleh **Administrator / Pengelola Server**.'
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  // ==========================================
  // 1. HANDLER /config
  // ==========================================
  if (commandName === 'config') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'set-main-server') {
      const inputGuildId = interaction.options.getString('guild_id')?.trim() || interaction.guildId;
      const guildObj = client.guilds.cache.get(inputGuildId);
      setSetting('main_guild_id', inputGuildId);

      const embed = new EmbedBuilder()
        .setColor(THEME.SUCCESS)
        .setTitle('🏠 Server Utama Pelacakan Diperbarui')
        .setDescription(
          `Server utama yang dilacak telah dikunci ke:\n` +
          `> **${guildObj ? guildObj.name : 'Server Utama'}** (\`${inputGuildId}\`)\n\n` +
          `💡 *Sekarang kamu dapat menjalankan perintah rekap & bukti log dari Server Khusus Log kapan saja.*`
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'set-log-channel') {
      const rawInput = interaction.options.getString('channel_id')?.trim();

      if (rawInput && ['off', 'none', 'disable', 'mati', 'reset'].includes(rawInput.toLowerCase())) {
        setSetting('log_channel_id', '');
        const embed = new EmbedBuilder()
          .setColor(THEME.WARNING)
          .setTitle('🔕 Pengiriman Log Eksternal Dimatikan')
          .setDescription(
            'Bot tidak lagi mengirim pesan log ke channel eksternal.\n\n' +
            '> ✅ **Tracker Tetap Aktif:** Seluruh perhitungan pesan & link bukti chat tetap berjalan dan tersimpan aman di database.'
          )
          .setTimestamp();
        return interaction.reply({ embeds: [embed] });
      }

      const targetChannelId = rawInput ? rawInput.replace(/[<#>]/g, '') : interaction.channelId;
      const channelObj = await client.channels.fetch(targetChannelId).catch(() => null);

      if (!channelObj || !channelObj.isTextBased()) {
        return interaction.reply({
          content: `❌ Channel dengan ID \`${targetChannelId}\` tidak ditemukan atau bukan channel teks. Pastikan bot sudah berada di server khusus log tersebut.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      setSetting('log_channel_id', targetChannelId);
      const embed = new EmbedBuilder()
        .setColor(THEME.SUCCESS)
        .setTitle('📡 Channel Bukti Log Berhasil Diaktifkan')
        .setDescription(
          `Bukti log pesan General Chat akan dikirim secara real-time ke:\n` +
          `> 📍 Channel: **#${channelObj.name}** (\`${targetChannelId}\`)\n` +
          `> 🏛️ Server: **${channelObj.guild?.name || 'Server Khusus Log'}**`
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'daily-target') {
      const target = interaction.options.getInteger('jumlah', true);
      setSetting('daily_target', target);
      const embed = new EmbedBuilder()
        .setColor(THEME.SUCCESS)
        .setTitle('🎯 Target Harian Diperbarui')
        .setDescription(
          `Target keaktifan harian berhasil diatur menjadi:\n` +
          `> 🔥 **${target} Pesan Valid / Hari** *(Minimal ${getConfig().minWords} kata per pesan)*`
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'min-words') {
      const minWords = interaction.options.getInteger('jumlah', true);
      setSetting('min_words', minWords);
      const embed = new EmbedBuilder()
        .setColor(THEME.SUCCESS)
        .setTitle('📏 Syarat Minimal Kata Diperbarui')
        .setDescription(
          `Batas minimal kata agar pesan dihitung berhasil diatur menjadi:\n` +
          `> 📝 **Minimal ${minWords} Kata Valid / Pesan**`
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'auto-recap') {
      const status = interaction.options.getString('status', true);
      const enabled = status === 'on';
      setSetting('auto_recap', String(enabled));

      const embed = new EmbedBuilder()
        .setColor(enabled ? THEME.SUCCESS : THEME.WARNING)
        .setTitle(enabled ? '📑 Laporan Tutup Buku Otomatis Diaktifkan' : '🔕 Laporan Tutup Buku Otomatis Dimatikan')
        .setDescription(
          enabled
            ? `Bot akan otomatis mengirimkan **Rekapitulasi Tutup Buku Harian + File CSV** setiap pukul \`00:00 WIB\` ke Channel Server Log.`
            : `Pengiriman laporan tutup buku otomatis setiap pukul \`00:00 WIB\` telah dinonaktifkan.`
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'reminder') {
      const status = interaction.options.getString('status', true);
      const enabled = status === 'on';
      const hourInput = interaction.options.getInteger('jam');
      const rawChannelId = interaction.options.getString('channel_id')?.trim();

      if (rawChannelId !== undefined && rawChannelId !== null) {
        if (['off', 'none', 'default', 'log'].includes(rawChannelId.toLowerCase())) {
          setSetting('reminder_channel_id', '');
        } else {
          const cleanChanId = rawChannelId.replace(/[<#>]/g, '');
          const channelObj = await client.channels.fetch(cleanChanId).catch(() => null);
          if (!channelObj || !channelObj.isTextBased()) {
            return interaction.reply({
              content: `❌ Channel dengan ID \`${cleanChanId}\` tidak ditemukan atau bukan channel teks.`,
              flags: MessageFlags.Ephemeral,
            });
          }
          setSetting('reminder_channel_id', cleanChanId);
        }
      }

      setSetting('reminder_enabled', String(enabled));
      if (hourInput !== null) {
        setSetting('reminder_hour', String(hourInput));
      }

      const cfg = getConfig();
      const hourStr = `${String(cfg.reminderHour).padStart(2, '0')}:00 WIB`;
      const targetChanDesc = cfg.reminderChannelId
        ? `<#${cfg.reminderChannelId}> (\`${cfg.reminderChannelId}\`)`
        : 'Mengikuti Channel Server Log';

      const embed = new EmbedBuilder()
        .setColor(enabled ? THEME.SUCCESS : THEME.WARNING)
        .setTitle(enabled ? '⏰ Auto-Reminder Malam Hari Diaktifkan' : '🔕 Auto-Reminder Malam Hari Dimatikan')
        .setDescription(
          enabled
            ? `Bot akan otomatis mengingatkan anggota yang belum mencapai target harian:\n` +
              `> 🕒 **Jadwal Pengingat:** Setiap pukul \`${hourStr}\`\n` +
              `> 📍 **Channel Tujuan:** ${targetChanDesc}`
            : `Pengingat malam otomatis telah dinonaktifkan.`
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'anti-monolog') {
      const cooldown = interaction.options.getInteger('cooldown_detik');
      const maxBeruntun = interaction.options.getInteger('max_beruntun');

      if (cooldown !== null) {
        setSetting('cooldown_seconds', String(cooldown));
      }
      if (maxBeruntun !== null) {
        setSetting('max_consecutive', String(maxBeruntun));
      }

      const cfg = getConfig();
      const cooldownDesc = cfg.cooldownSeconds > 0 ? `**${cfg.cooldownSeconds} detik**` : '*Dimatikan (`0s`)*';
      const maxDesc = cfg.maxConsecutive > 0 ? `**${cfg.maxConsecutive} pesan beruntun**` : '*Dimatikan (`Unlimited`)*';

      const embed = new EmbedBuilder()
        .setColor(THEME.SUCCESS)
        .setTitle('🛡️ Pengaturan Anti-Monolog & Cooldown Diperbarui')
        .setDescription(
          `Aturan pencegahan kejar setoran / chat beruntun sendirian:\n` +
          `> ⏱️ **Cooldown Antar Pesan:** ${cooldownDesc}\n` +
          `> 🗣️ **Batas Chat Beruntun Sendirian:** ${maxDesc}\n\n` +
          `*Catatan: Batas chat beruntun otomatis ter-reset begitu ada chat dari orang lain (termasuk member biasa).*`
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'prefix') {
      const newPrefix = interaction.options.getString('teks', true).trim().toLowerCase();
      setSetting('command_prefix', newPrefix);

      const embed = new EmbedBuilder()
        .setColor(THEME.SUCCESS)
        .setTitle('⌨️ Prefix Command Diperbarui')
        .setDescription(
          `Prefix command teks berhasil diubah menjadi \`${newPrefix}\`.\n` +
          `> Contoh penggunaan: \`${newPrefix}status\`, \`${newPrefix}monitor\`, \`${newPrefix}logs\`, \`${newPrefix}help\``
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'view') {
      const cfg = getConfig();
      const targetGuildId = resolveTargetGuildId(interaction);
      const mainGuild = client.guilds.cache.get(targetGuildId);
      const roles = getTrackedRoles(targetGuildId);
      const cmdRoles = getCommandRoles(interaction.guildId);
      const users = getTrackedUsers(targetGuildId);
      const channels = getTrackedChannels(targetGuildId);

      let logStatus = '⚪ Belum Diset (Tracker Tetap Aktif & Tersimpan di DB)';
      if (cfg.logChannelId) {
        const logChan = client.channels.cache.get(cfg.logChannelId);
        logStatus = logChan
          ? `🟢 Aktif → #${logChan.name} (${logChan.guild?.name})`
          : `🟢 Aktif → Channel ID: ${cfg.logChannelId}`;
      }

      const recapStatus = cfg.autoRecap ? '🟢 Aktif (Tiap 00:00 WIB + CSV)' : '🔴 Nonaktif';
      const reminderHourStr = `${String(cfg.reminderHour).padStart(2, '0')}:00 WIB`;
      const reminderStatus = cfg.reminderEnabled
        ? `🟢 Aktif (Tiap ${reminderHourStr})`
        : '🔴 Nonaktif';
      const antiMonologStatus = `Cooldown ${cfg.cooldownSeconds}s | Max ${cfg.maxConsecutive > 0 ? `${cfg.maxConsecutive} beruntun` : 'Unlimited'}`;

      const embed = new EmbedBuilder()
        .setAuthor({
          name: 'Control Panel • General Chat Tracker',
          iconURL: client.user.displayAvatarURL(),
        })
        .setTitle('⚙️ Dashboard Konfigurasi Sistem')
        .setColor(THEME.PRIMARY)
        .setThumbnail(mainGuild?.iconURL() || client.user.displayAvatarURL())
        .setDescription(
          `\`\`\`yaml\n` +
          `Server Utama   : ${mainGuild ? mainGuild.name : targetGuildId}\n` +
          `Prefix Command : ${cfg.prefix} (contoh: ${cfg.prefix}status, ${cfg.prefix}monitor)\n` +
          `Target Harian  : ${cfg.dailyTarget} Pesan / Hari\n` +
          `Minimal Kata   : ${cfg.minWords} Kata Valid / Pesan\n` +
          `Anti-Monolog   : ${antiMonologStatus}\n` +
          `Server Log     : ${logStatus}\n` +
          `Tutup Buku Auto: ${recapStatus}\n` +
          `Auto-Reminder  : ${reminderStatus}\n` +
          `Tanggal Server : ${getDateWIB()} (WIB)\n` +
          `\`\`\``
        )
        .addFields(
          {
            name: `🎭 Role yang Dilacak Chatnya (${roles.length})`,
            value: roles.length
              ? roles.map((r) => `• <@&${r.role_id}> (**${r.role_name}**)`).join('\n')
              : '> *Belum ada role (gunakan `/target-role add`)*',
            inline: true,
          },
          {
            name: `🔐 Role Akses Command (${cmdRoles.length})`,
            value: cmdRoles.length
              ? cmdRoles.map((r) => `• <@&${r.role_id}> (**${r.role_name}**)`).join('\n')
              : '> *Mengikuti Role yang Dilacak & Admin (atur via `/command-role add`)*',
            inline: true,
          },
          {
            name: `💬 Channel General Chat (${channels.length})`,
            value: channels.length
              ? channels.map((c) => `• <#${c.channel_id}> (**#${c.channel_name}**)`).join('\n')
              : '> *Semua channel di Server Utama (gunakan `/channel add` untuk khusus #general)*',
            inline: false,
          },
          {
            name: `👤 User Spesifik Tambahan (${users.length})`,
            value: users.length
              ? users.map((u) => `• <@${u.user_id}> (**${u.username}**)`).join('\n')
              : '> *Tidak ada user spesifik tambahan*',
            inline: false,
          }
        )
        .setFooter({ text: 'Gunakan /command-role untuk membatasi siapa yang boleh memakai command bot' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }
  }

  // ==========================================
  // 2. HANDLER /command-role (Izin Pakai Command)
  // ==========================================
  if (commandName === 'command-role') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      const role = interaction.options.getRole('role', true);
      addCommandRole(interaction.guildId, role.id, role.name);
      const embed = new EmbedBuilder()
        .setColor(THEME.SUCCESS)
        .setTitle('🔐 Izin Akses Command Ditambahkan')
        .setDescription(
          `Role <@&${role.id}> (**@${role.name}**) sekarang **diizinkan** menggunakan command bot di server ini.`
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'remove') {
      const role = interaction.options.getRole('role', true);
      const removed = removeCommandRole(interaction.guildId, role.id);
      const embed = new EmbedBuilder()
        .setColor(removed ? THEME.WARNING : THEME.DANGER)
        .setTitle(removed ? '🗑️ Izin Akses Command Dicabut' : '⚠️ Role Tidak Ditemukan')
        .setDescription(
          removed
            ? `Role <@&${role.id}> (**@${role.name}**) tidak lagi memiliki akses command bot.`
            : `Role <@&${role.id}> belum terdaftar di dalam daftar izin command.`
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'list') {
      const roles = getCommandRoles(interaction.guildId);
      const embed = new EmbedBuilder()
        .setColor(THEME.PRIMARY)
        .setTitle(`🔐 Daftar Role yang Diizinkan Memakai Command (${roles.length})`)
        .setDescription(
          roles.length
            ? roles.map((r, i) => `\`${i + 1}.\` <@&${r.role_id}> (**@${r.role_name}**)`).join('\n')
            : '> ℹ️ *Belum ada role khusus yang diatur. Saat ini akses command terbuka untuk **Administrator** dan **Role yang Dilacak (`/target-role`)**.*\n\nGunakan `/command-role add` untuk mengatur role khusus.'
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }
  }

  // ==========================================
  // 3. HANDLER /target-role
  // ==========================================
  if (commandName === 'target-role') {
    const sub = interaction.options.getSubcommand();
    const targetGuildId = getSetting('main_guild_id') || interaction.guildId;

    if (!getSetting('main_guild_id')) {
      setSetting('main_guild_id', interaction.guildId);
    }

    if (sub === 'add') {
      const role = interaction.options.getRole('role', true);
      addTrackedRole(targetGuildId, role.id, role.name);
      const embed = new EmbedBuilder()
        .setColor(THEME.SUCCESS)
        .setTitle('🎭 Role Target Pelacakan Ditambahkan')
        .setDescription(
          `Role <@&${role.id}> (**@${role.name}**) berhasil masuk ke dalam radar pelacakan!\n` +
          `> Setiap pesan minimal **${getConfig().minWords} kata valid** dari role ini akan dihitung ke target harian.`
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'remove') {
      const role = interaction.options.getRole('role', true);
      const removed = removeTrackedRole(targetGuildId, role.id);
      const embed = new EmbedBuilder()
        .setColor(removed ? THEME.WARNING : THEME.DANGER)
        .setTitle(removed ? '🗑️ Role Dihapus dari Pelacakan' : '⚠️ Role Tidak Ditemukan')
        .setDescription(
          removed
            ? `Role <@&${role.id}> (**@${role.name}**) tidak lagi dilacak pesannya.`
            : `Role <@&${role.id}> tidak ada di dalam daftar pelacakan.`
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'list') {
      const roles = getTrackedRoles(targetGuildId);
      const embed = new EmbedBuilder()
        .setColor(THEME.PRIMARY)
        .setTitle(`🎭 Daftar Role yang Dilacak (${roles.length})`)
        .setDescription(
          roles.length
            ? roles.map((r, i) => `\`${i + 1}.\` <@&${r.role_id}> (**@${r.role_name}** — \`${r.role_id}\`)`).join('\n')
            : '> ℹ️ *Belum ada role yang dilacak. Gunakan `/target-role add` untuk menambahkan.*'
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }
  }

  // ==========================================
  // 4. HANDLER /target-user
  // ==========================================
  if (commandName === 'target-user') {
    const sub = interaction.options.getSubcommand();
    const targetGuildId = resolveTargetGuildId(interaction);

    if (!getSetting('main_guild_id')) {
      setSetting('main_guild_id', interaction.guildId);
    }

    if (sub === 'add') {
      const user = interaction.options.getUser('user', true);
      addTrackedUser(targetGuildId, user.id, user.tag);
      const embed = new EmbedBuilder()
        .setColor(THEME.SUCCESS)
        .setTitle('👤 User Target Ditambahkan')
        .setDescription(`User <@${user.id}> (**${user.tag}**) berhasil ditambahkan ke daftar pelacakan khusus.`)
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'remove') {
      const user = interaction.options.getUser('user', true);
      const removed = removeTrackedUser(targetGuildId, user.id);
      const embed = new EmbedBuilder()
        .setColor(removed ? THEME.WARNING : THEME.DANGER)
        .setTitle(removed ? '🗑️ User Dihapus dari Pelacakan' : '⚠️ User Tidak Ditemukan')
        .setDescription(
          removed
            ? `User <@${user.id}> berhasil dihapus dari daftar pelacakan khusus.`
            : `User <@${user.id}> tidak ditemukan di daftar pelacakan khusus.`
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'list') {
      const users = getTrackedUsers(targetGuildId);
      const embed = new EmbedBuilder()
        .setColor(THEME.PRIMARY)
        .setTitle(`👤 Daftar User Spesifik yang Dilacak (${users.length})`)
        .setDescription(
          users.length
            ? users.map((u, i) => `\`${i + 1}.\` <@${u.user_id}> (**${u.username}** — \`${u.user_id}\`)`).join('\n')
            : '> ℹ️ *Belum ada user spesifik tambahan. Gunakan `/target-user add` jika perlu.*'
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }
  }

  // ==========================================
  // 5. HANDLER /channel
  // ==========================================
  if (commandName === 'channel') {
    const sub = interaction.options.getSubcommand();
    const targetGuildId = resolveTargetGuildId(interaction);

    if (!getSetting('main_guild_id')) {
      setSetting('main_guild_id', interaction.guildId);
    }

    if (sub === 'add') {
      const channel = interaction.options.getChannel('channel', true);
      addTrackedChannel(targetGuildId, channel.id, channel.name);
      const embed = new EmbedBuilder()
        .setColor(THEME.SUCCESS)
        .setTitle('💬 Channel General Chat Ditambahkan')
        .setDescription(`Channel <#${channel.id}> (**#${channel.name}**) sekarang aktif dipantau oleh bot!`)
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'remove') {
      const channel = interaction.options.getChannel('channel', true);
      const removed = removeTrackedChannel(targetGuildId, channel.id);
      const embed = new EmbedBuilder()
        .setColor(removed ? THEME.WARNING : THEME.DANGER)
        .setTitle(removed ? '🗑️ Channel Dihapus dari Pantauan' : '⚠️ Channel Tidak Ditemukan')
        .setDescription(
          removed
            ? `Channel <#${channel.id}> berhasil dihapus dari daftar pelacakan.`
            : `Channel <#${channel.id}> tidak ada di daftar pelacakan.`
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'list') {
      const channels = getTrackedChannels(targetGuildId);
      const embed = new EmbedBuilder()
        .setColor(THEME.PRIMARY)
        .setTitle(`💬 Daftar Channel yang Dilacak (${channels.length})`)
        .setDescription(
          channels.length
            ? channels.map((c, i) => `\`${i + 1}.\` <#${c.channel_id}> (**#${c.channel_name}** — \`${c.channel_id}\`)`).join('\n')
            : '> ℹ️ *Belum ada filter channel spesifik (semua channel di server utama dihitung). Gunakan `/channel add` untuk membatasi hanya di `#general-chat`.*'
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }
  }

  // ==========================================
  // 6. HANDLER /stats
  // ==========================================
  if (commandName === 'stats') {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const rawDate = interaction.options.getString('tanggal')?.trim();
    if (rawDate && !isValidDateString(rawDate)) {
      return interaction.reply({
        content: '❌ Format tanggal tidak valid. Gunakan format `YYYY-MM-DD` (contoh: `2026-11-12`).',
        flags: MessageFlags.Ephemeral,
      });
    }
    const dateInput = rawDate || getDateWIB();
    const targetGuildId = resolveTargetGuildId(interaction);

    const payload = buildStatsPayload(targetUser, targetGuildId, dateInput);
    return interaction.reply(payload);
  }

  // ==========================================
  // 7. HANDLER /monitor
  // ==========================================
  if (commandName === 'monitor') {
    const period = interaction.options.getString('periode') || 'today';
    const rawDate = interaction.options.getString('tanggal')?.trim();
    if (rawDate && !isValidDateString(rawDate)) {
      return interaction.reply({
        content: '❌ Format tanggal tidak valid. Gunakan format `YYYY-MM-DD` (contoh: `2026-11-12`).',
        flags: MessageFlags.Ephemeral,
      });
    }
    const dateInput = rawDate || getDateWIB();
    const targetGuildId = resolveTargetGuildId(interaction);

    await interaction.deferReply();
    const payload = await buildMonitorPayload(client, targetGuildId, period, dateInput);
    return interaction.editReply(payload);
  }

  // ==========================================
  // 8. HANDLER /logs (Cek Bukti Log)
  // ==========================================
  if (commandName === 'logs') {
    const user = interaction.options.getUser('user');
    const dateWib = interaction.options.getString('tanggal')?.trim() || null;
    if (dateWib && !isValidDateString(dateWib)) {
      return interaction.reply({
        content: '❌ Format tanggal tidak valid. Gunakan format `YYYY-MM-DD` (contoh: `2026-11-12`).',
        flags: MessageFlags.Ephemeral,
      });
    }
    const limit = interaction.options.getInteger('jumlah') || 10;
    const targetGuildId = resolveTargetGuildId(interaction);

    const logs = getMessageLogs({
      guildId: targetGuildId,
      userId: user?.id || null,
      dateWib,
      limit,
    });

    if (!logs.length) {
      return interaction.reply({
        content: '📭 Tidak ditemukan bukti log pesan untuk filter tersebut.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const headerText =
      `\`\`\`yaml\n` +
      `Filter User    : ${user ? user.tag : 'Semua User'}\n` +
      `Filter Tanggal : ${dateWib || 'Semua Waktu'}\n` +
      `Jumlah Tampil  : ${logs.length} Bukti Terbaru\n` +
      `\`\`\`\n` +
      `${DIVIDER}\n\n`;

    const logLines = logs.map((l, i) => {
      const snippet = formatSnippet(l.content, 70);
      const timestampSec = Math.floor(l.created_at / 1000);
      return (
        `\`#${String(i + 1).padStart(2, '0')}\` <@${l.user_id}> di **#${l.channel_name}** • <t:${timestampSec}:R>\n` +
        `┗ 📝 \`${l.word_count} kata\` — *"${snippet}"* — **[🔗 Bukti Pesan](${l.message_url})**`
      );
    });

    const description = joinLinesWithinLimit(logLines, 4096 - headerText.length, '\n\n');

    const embed = new EmbedBuilder()
      .setAuthor({
        name: 'Audit & Bukti Log General Chat',
        iconURL: client.user.displayAvatarURL(),
      })
      .setTitle(`📋 Arsip Bukti Pesan Valid`)
      .setColor(THEME.INFO)
      .setDescription(`${headerText}${description}`)
      .setFooter({ text: 'Klik "Bukti Pesan" untuk melompat langsung ke chat asli di Discord' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  // ==========================================
  // 9. HANDLER /export (Export CSV)
  // ==========================================
  if (commandName === 'export') {
    const dateWib = interaction.options.getString('tanggal')?.trim() || null;
    if (dateWib && !isValidDateString(dateWib)) {
      return interaction.reply({
        content: '❌ Format tanggal tidak valid. Gunakan format `YYYY-MM-DD` (contoh: `2026-11-12`).',
        flags: MessageFlags.Ephemeral,
      });
    }
    const user = interaction.options.getUser('user');
    const targetGuildId = resolveTargetGuildId(interaction);
    const cfg = getConfig();

    await interaction.deferReply();
    const logs = getMessageLogs({
      guildId: targetGuildId,
      userId: user?.id || null,
      dateWib,
      limit: 5000,
    });

    if (!logs.length) {
      return interaction.editReply({
        content: '📭 Tidak ada data log untuk di-export pada filter tersebut.',
      });
    }

    const csvContent = generateLogsCsv(logs, cfg.dailyTarget);
    const fileName = `bukti-log-chat-${dateWib || 'semua'}-${Date.now()}.csv`;
    const attachment = new AttachmentBuilder(Buffer.from(csvContent, 'utf-8'), {
      name: fileName,
    });

    const embed = new EmbedBuilder()
      .setColor(THEME.SUCCESS)
      .setTitle('📂 Export Laporan Bukti Log Berhasil')
      .setDescription(
        `Berhasil mengekspor **${logs.length} bukti pesan valid** ke dalam format CSV.\n` +
        `> File terlampir di bawah dapat dibuka langsung menggunakan **Microsoft Excel** atau **Google Sheets**.`
      )
      .setTimestamp();

    return interaction.editReply({
      embeds: [embed],
      files: [attachment],
    });
  }

  // ==========================================
  // 10. HANDLER /reset
  // ==========================================
  if (commandName === 'reset') {
    const scope = interaction.options.getString('cakupan', true);
    const user = interaction.options.getUser('user');
    const targetGuildId = resolveTargetGuildId(interaction);

    if (scope === 'user' && !user) {
      return interaction.reply({
        content: '❌ Kamu harus memilih parameter `user` jika ingin mereset data user tertentu.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const deletedCount = resetLogs({
      guildId: targetGuildId,
      scope,
      userId: user?.id || null,
      dateWib: getDateWIB(),
    });

    const embed = new EmbedBuilder()
      .setColor(THEME.WARNING)
      .setTitle('🧹 Data Log Berhasil Direset')
      .setDescription(`Berhasil menghapus **${deletedCount} data bukti log** (Cakupan: \`${scope}\`).`)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
}

module.exports = {
  commandDefinitions,
  handleInteraction,
  isAdminOrOwner,
  hasCommandAccess,
  resolveTargetGuildId,
  isValidDateString,
  buildAccessDeniedEmbed,
  buildStatsPayload,
  buildMonitorPayload,
};
