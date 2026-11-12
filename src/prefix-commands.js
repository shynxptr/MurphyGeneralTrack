const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
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
  getMessageLogs,
  resetLogs,
} = require('./database');

const {
  THEME,
  DIVIDER,
  generateLogsCsv,
  formatSnippet,
  joinLinesWithinLimit,
} = require('./utils');

const {
  isAdminOrOwner,
  hasCommandAccess,
  resolveTargetGuildId,
  isValidDateString,
  buildAccessDeniedEmbed,
  buildStatsPayload,
  buildMonitorPayload,
} = require('./commands');

/**
 * Daftar nama command (tanpa prefix) beserta aliasnya
 */
const COMMAND_ALIASES = {
  help: 'help',
  commands: 'help',
  list: 'help',

  status: 'status',
  stats: 'status',
  st: 'status',

  monitor: 'monitor',
  mon: 'monitor',
  m: 'monitor',

  logs: 'logs',
  log: 'logs',

  export: 'export',
  csv: 'export',

  config: 'config',
  cfg: 'config',

  cmdrole: 'cmdrole',
  commandrole: 'cmdrole',

  targetrole: 'targetrole',
  trole: 'targetrole',

  targetuser: 'targetuser',
  tuser: 'targetuser',

  channel: 'channel',
  ch: 'channel',

  reset: 'reset',
};

/**
 * Mengurai pesan teks menjadi { command, args } hanya jika cocok dengan prefix + command yang valid.
 * Kata chat biasa seperti "gimana kabar kalian" tidak akan pernah dianggap sebagai command.
 *
 * @param {string} content
 * @param {string} prefix
 * @returns {{ command: string, args: string[] } | null}
 */
function parsePrefixCommand(content, prefix) {
  if (!content || !prefix) return null;
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();

  if (!lower.startsWith(lowerPrefix)) return null;

  const rest = trimmed.slice(prefix.length);
  if (!rest || /^\s/.test(rest)) return null; // harus menempel dengan prefix (contoh: gstatus)

  const parts = rest.split(/\s+/);
  const rawCmd = parts[0].toLowerCase();
  const canonical = COMMAND_ALIASES[rawCmd];

  if (!canonical) return null;

  return {
    command: canonical,
    args: parts.slice(1),
  };
}

function extractSnowflake(raw) {
  if (!raw) return null;
  const match = raw.match(/\d{17,20}/);
  return match ? match[0] : null;
}

/**
 * Menjalankan Prefix Command jika pesan cocok.
 * Mengembalikan true jika pesan diproses sebagai command (agar tidak dihitung sebagai chat tracker).
 *
 * @param {import('discord.js').Message} message
 * @param {import('discord.js').Client} client
 * @returns {Promise<boolean>}
 */
async function handlePrefixCommand(message, client) {
  const cfg = getConfig();
  const parsed = parsePrefixCommand(message.content, cfg.prefix);
  if (!parsed) return false;

  const { command, args } = parsed;

  // 1. Cek Akses Role (Sama persis dengan Slash Command)
  if (!hasCommandAccess(message)) {
    const cmdRoles = getCommandRoles(message.guildId);
    const fallbackRoles = cmdRoles.length ? cmdRoles : getTrackedRoles(message.guildId);
    await message.reply({
      embeds: [
        buildAccessDeniedEmbed(
          'Maaf, perintah bot ini **hanya dapat digunakan oleh Role yang diizinkan**.',
          fallbackRoles
        ),
      ],
    }).catch(() => null);
    return true;
  }

  // Command khusus Admin / Owner Server
  const adminOnly = ['config', 'cmdrole', 'targetrole', 'targetuser', 'channel', 'reset'];
  if (adminOnly.includes(command) && !isAdminOrOwner(message)) {
    await message.reply({
      embeds: [
        buildAccessDeniedEmbed(
          'Perintah konfigurasi ini hanya dapat dijalankan oleh **Administrator / Pengelola Server**.'
        ),
      ],
    }).catch(() => null);
    return true;
  }

  const p = cfg.prefix;
  const targetGuildId = resolveTargetGuildId(message);

  // ==========================================
  // 1. ghelp
  // ==========================================
  if (command === 'help') {
    const embed = new EmbedBuilder()
      .setAuthor({
        name: 'Panduan Prefix Command • General Chat Tracker',
        iconURL: client.user.displayAvatarURL(),
      })
      .setTitle(`📘 Daftar Command (Prefix: \`${p}\`)`)
      .setColor(THEME.PRIMARY)
      .setDescription(
        `Semua perintah dapat dijalankan dengan awalan \`${p}\` maupun Slash Command \`/\`.\n${DIVIDER}`
      )
      .addFields(
        {
          name: '📊 Pemantauan & Bukti Log',
          value:
            `• \`${p}status [@user] [YYYY-MM-DD]\` — Cek rapor keaktifan & progress target\n` +
            `• \`${p}monitor [today|7days|month|all] [YYYY-MM-DD]\` — Panel monitoring internal\n` +
            `• \`${p}logs [@user] [YYYY-MM-DD] [jumlah]\` — Lihat daftar bukti pesan & link\n` +
            `• \`${p}export [YYYY-MM-DD] [@user]\` — Unduh file CSV bukti log`,
          inline: false,
        },
        {
          name: '⚙️ Konfigurasi & Target (Khusus Admin)',
          value:
            `• \`${p}config view\` — Lihat seluruh pengaturan aktif\n` +
            `• \`${p}config prefix <teks>\` — Ganti prefix command\n` +
            `• \`${p}config target <jumlah>\` — Atur target harian (misal \`100\`)\n` +
            `• \`${p}config minwords <jumlah>\` — Atur minimal kata (default \`4\`)\n` +
            `• \`${p}config antimonolog <cooldown> <max>\` — Atur jeda & batas chat beruntun\n` +
            `• \`${p}config logchannel [#channel/off]\` — Atur channel bukti log\n` +
            `• \`${p}config mainserver [guild_id]\` — Tetapkan server utama\n` +
            `• \`${p}config autorecap <on/off>\` — Laporan tutup buku \`00:00 WIB\`\n` +
            `• \`${p}config reminder <on/off> [jam] [#channel]\` — Auto-reminder malam`,
          inline: false,
        },
        {
          name: '🎭 Manajemen Role, Channel, & Reset (Khusus Admin)',
          value:
            `• \`${p}cmdrole <add|remove|list> [@role]\` — Atur role yang boleh pakai command\n` +
            `• \`${p}targetrole <add|remove|list> [@role]\` — Atur role yang dilacak chatnya\n` +
            `• \`${p}targetuser <add|remove|list> [@user]\` — Atur user spesifik yang dilacak\n` +
            `• \`${p}channel <add|remove|list> [#channel]\` — Atur channel yang dipantau\n` +
            `• \`${p}reset <today|user|all> [@user]\` — Reset data log`,
          inline: false,
        }
      )
      .setFooter({ text: `Alias cepat: ${p}st (status), ${p}mon (monitor), ${p}log (logs), ${p}cfg (config)` })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
    return true;
  }

  // ==========================================
  // 2. gstatus / gstats
  // ==========================================
  if (command === 'status') {
    let targetUser = message.mentions.users.first() || null;
    let dateInput = null;

    for (const arg of args) {
      if (isValidDateString(arg)) {
        dateInput = arg;
      } else if (!targetUser) {
        const uid = extractSnowflake(arg);
        if (uid) {
          targetUser = await client.users.fetch(uid).catch(() => null);
        }
      }
    }

    if (!targetUser) targetUser = message.author;
    if (!dateInput) dateInput = getDateWIB();

    const payload = buildStatsPayload(targetUser, targetGuildId, dateInput);
    await message.reply(payload);
    return true;
  }

  // ==========================================
  // 3. gmonitor
  // ==========================================
  if (command === 'monitor') {
    const periodMap = {
      today: 'today',
      hariini: 'today',
      '7days': '7days',
      '7hari': '7days',
      week: '7days',
      minggu: '7days',
      month: 'month',
      bulan: 'month',
      all: 'all',
      semua: 'all',
    };

    let period = 'today';
    let dateInput = getDateWIB();

    for (const arg of args) {
      const low = arg.toLowerCase();
      if (periodMap[low]) {
        period = periodMap[low];
      } else if (isValidDateString(arg)) {
        dateInput = arg;
      }
    }

    const payload = await buildMonitorPayload(client, targetGuildId, period, dateInput);
    await message.reply(payload);
    return true;
  }

  // ==========================================
  // 4. glogs
  // ==========================================
  if (command === 'logs') {
    let user = message.mentions.users.first() || null;
    let dateWib = null;
    let limit = 10;

    for (const arg of args) {
      if (isValidDateString(arg)) {
        dateWib = arg;
      } else if (/^\d{1,2}$/.test(arg)) {
        const n = parseInt(arg, 10);
        if (n >= 1 && n <= 20) limit = n;
      } else if (!user) {
        const uid = extractSnowflake(arg);
        if (uid) {
          user = await client.users.fetch(uid).catch(() => null);
        }
      }
    }

    const logs = getMessageLogs({
      guildId: targetGuildId,
      userId: user?.id || null,
      dateWib,
      limit,
    });

    if (!logs.length) {
      await message.reply('📭 Tidak ditemukan bukti log pesan untuk filter tersebut.');
      return true;
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
      .setTitle('📋 Arsip Bukti Pesan Valid')
      .setColor(THEME.INFO)
      .setDescription(`${headerText}${description}`)
      .setFooter({ text: 'Klik "Bukti Pesan" untuk melompat langsung ke chat asli di Discord' })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
    return true;
  }

  // ==========================================
  // 5. gexport
  // ==========================================
  if (command === 'export') {
    let user = message.mentions.users.first() || null;
    let dateWib = null;

    for (const arg of args) {
      if (isValidDateString(arg)) {
        dateWib = arg;
      } else if (!user) {
        const uid = extractSnowflake(arg);
        if (uid) {
          user = await client.users.fetch(uid).catch(() => null);
        }
      }
    }

    const logs = getMessageLogs({
      guildId: targetGuildId,
      userId: user?.id || null,
      dateWib,
      limit: 5000,
    });

    if (!logs.length) {
      await message.reply('📭 Tidak ada data log untuk di-export pada filter tersebut.');
      return true;
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

    await message.reply({ embeds: [embed], files: [attachment] });
    return true;
  }

  // ==========================================
  // 6. gconfig
  // ==========================================
  if (command === 'config') {
    const sub = (args[0] || 'view').toLowerCase();

    if (sub === 'view') {
      const mainGuild = client.guilds.cache.get(targetGuildId);
      const roles = getTrackedRoles(targetGuildId);
      const cmdRoles = getCommandRoles(message.guildId);
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
      const reminderStatus = cfg.reminderEnabled ? `🟢 Aktif (Tiap ${reminderHourStr})` : '🔴 Nonaktif';
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
              : `> *Belum ada role (gunakan \`${p}targetrole add @role\`)*`,
            inline: true,
          },
          {
            name: `🔐 Role Akses Command (${cmdRoles.length})`,
            value: cmdRoles.length
              ? cmdRoles.map((r) => `• <@&${r.role_id}> (**${r.role_name}**)`).join('\n')
              : `> *Mengikuti Role yang Dilacak & Admin (atur via \`${p}cmdrole add @role\`)*`,
            inline: true,
          },
          {
            name: `💬 Channel General Chat (${channels.length})`,
            value: channels.length
              ? channels.map((c) => `• <#${c.channel_id}> (**#${c.channel_name}**)`).join('\n')
              : `> *Semua channel di Server Utama (atur via \`${p}channel add #channel\`)*`,
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
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      return true;
    }

    if (sub === 'prefix') {
      const newPrefix = args[1]?.trim().toLowerCase();
      if (!newPrefix || newPrefix.length > 5) {
        await message.reply(`❌ Format salah. Contoh: \`${p}config prefix g\` (maksimal 5 karakter).`);
        return true;
      }
      setSetting('command_prefix', newPrefix);
      await message.reply(
        `✅ Prefix command berhasil diubah menjadi \`${newPrefix}\`. Contoh: \`${newPrefix}status\`, \`${newPrefix}monitor\`.`
      );
      return true;
    }

    if (sub === 'mainserver' || sub === 'main-server') {
      const inputGuildId = extractSnowflake(args[1]) || message.guildId;
      const guildObj = client.guilds.cache.get(inputGuildId);
      setSetting('main_guild_id', inputGuildId);
      await message.reply(
        `✅ **Server Utama Pelacakan** diatur ke **${guildObj ? guildObj.name : inputGuildId}** (\`${inputGuildId}\`).`
      );
      return true;
    }

    if (sub === 'logchannel' || sub === 'log-channel') {
      const raw = args[1]?.trim();
      if (raw && ['off', 'none', 'disable', 'mati', 'reset'].includes(raw.toLowerCase())) {
        setSetting('log_channel_id', '');
        await message.reply(
          '✅ **Pengiriman Log Eksternal Dimatikan.** *(Tracker tetap berjalan dan menyimpan bukti di database).*'
        );
        return true;
      }
      const chanId = extractSnowflake(raw) || message.channelId;
      const chanObj = await client.channels.fetch(chanId).catch(() => null);
      if (!chanObj || !chanObj.isTextBased()) {
        await message.reply(`❌ Channel \`${chanId}\` tidak ditemukan atau bukan channel teks.`);
        return true;
      }
      setSetting('log_channel_id', chanId);
      await message.reply(
        `✅ **Channel Bukti Log** diatur ke **#${chanObj.name}** (\`${chanId}\`) di server **${chanObj.guild?.name}**.`
      );
      return true;
    }

    if (sub === 'target' || sub === 'dailytarget' || sub === 'daily-target') {
      const num = parseInt(args[1], 10);
      if (Number.isNaN(num) || num < 1 || num > 10000) {
        await message.reply(`❌ Masukkan angka target harian yang valid (1–10000). Contoh: \`${p}config target 100\``);
        return true;
      }
      setSetting('daily_target', num);
      await message.reply(`🎯 **Target Harian** berhasil diubah menjadi **${num} pesan/hari**.`);
      return true;
    }

    if (sub === 'minwords' || sub === 'min-words') {
      const num = parseInt(args[1], 10);
      if (Number.isNaN(num) || num < 1 || num > 100) {
        await message.reply(`❌ Masukkan angka minimal kata yang valid (1–100). Contoh: \`${p}config minwords 4\``);
        return true;
      }
      setSetting('min_words', num);
      await message.reply(`📝 **Syarat Minimal Kata** berhasil diubah menjadi **${num} kata valid**.`);
      return true;
    }

    if (sub === 'antimonolog' || sub === 'anti-monolog') {
      const cd = args[1] !== undefined ? parseInt(args[1], 10) : null;
      const maxC = args[2] !== undefined ? parseInt(args[2], 10) : null;
      if (cd === null || Number.isNaN(cd) || cd < 0 || cd > 300) {
        await message.reply(
          `❌ Format: \`${p}config antimonolog <cooldown_detik> [max_beruntun]\`\nContoh: \`${p}config antimonolog 5 3\` (isi \`0\` untuk mematikan).`
        );
        return true;
      }
      setSetting('cooldown_seconds', String(cd));
      if (maxC !== null && !Number.isNaN(maxC) && maxC >= 0 && maxC <= 50) {
        setSetting('max_consecutive', String(maxC));
      }
      const updated = getConfig();
      await message.reply(
        `🛡️ **Anti-Monolog Diperbarui:** Cooldown \`${updated.cooldownSeconds}s\` | Max Beruntun \`${updated.maxConsecutive > 0 ? updated.maxConsecutive : 'Unlimited'}\`.`
      );
      return true;
    }

    if (sub === 'autorecap' || sub === 'auto-recap') {
      const state = args[1]?.toLowerCase();
      if (!['on', 'off'].includes(state)) {
        await message.reply(`❌ Gunakan \`on\` atau \`off\`. Contoh: \`${p}config autorecap on\``);
        return true;
      }
      setSetting('auto_recap', String(state === 'on'));
      await message.reply(
        state === 'on'
          ? '📑 **Laporan Tutup Buku Otomatis (`00:00 WIB` + CSV)** diaktifkan.'
          : '🔕 **Laporan Tutup Buku Otomatis** dimatikan.'
      );
      return true;
    }

    if (sub === 'reminder') {
      const state = args[1]?.toLowerCase();
      if (!['on', 'off'].includes(state)) {
        await message.reply(
          `❌ Format: \`${p}config reminder <on|off> [jam_wib] [#channel]\`\nContoh: \`${p}config reminder on 20\``
        );
        return true;
      }
      setSetting('reminder_enabled', String(state === 'on'));
      if (args[2] !== undefined && /^\d{1,2}$/.test(args[2])) {
        const h = parseInt(args[2], 10);
        if (h >= 0 && h <= 23) setSetting('reminder_hour', String(h));
      }
      const chanArg = args.find((a, idx) => idx >= 2 && extractSnowflake(a));
      if (chanArg) {
        const cid = extractSnowflake(chanArg);
        const chanObj = await client.channels.fetch(cid).catch(() => null);
        if (!chanObj || !chanObj.isTextBased()) {
          await message.reply(`❌ Channel \`${cid}\` tidak ditemukan atau bukan channel teks.`);
          return true;
        }
        setSetting('reminder_channel_id', cid);
      }
      const updated = getConfig();
      await message.reply(
        updated.reminderEnabled
          ? `⏰ **Auto-Reminder Diaktifkan:** Pukul \`${String(updated.reminderHour).padStart(2, '0')}:00 WIB\`.`
          : '🔕 **Auto-Reminder Malam Hari** dimatikan.'
      );
      return true;
    }

    await message.reply(`❓ Subcommand tidak dikenali. Ketik \`${p}help\` untuk melihat daftar perintah.`);
    return true;
  }

  // ==========================================
  // 7. gcmdrole
  // ==========================================
  if (command === 'cmdrole') {
    const sub = (args[0] || 'list').toLowerCase();
    if (sub === 'list') {
      const roles = getCommandRoles(message.guildId);
      const text = roles.length
        ? roles.map((r, i) => `\`${i + 1}.\` <@&${r.role_id}> (**@${r.role_name}**)`).join('\n')
        : `> ℹ️ Belum ada role khusus. Saat ini mengikuti **Administrator** & **Role Target (\`${p}targetrole\`)**.`;
      await message.reply({
        embeds: [new EmbedBuilder().setColor(THEME.PRIMARY).setTitle(`🔐 Role Akses Command (${roles.length})`).setDescription(text)],
      });
      return true;
    }

    const roleId = extractSnowflake(args[1]);
    const role = message.mentions.roles.first() || (roleId ? message.guild.roles.cache.get(roleId) : null);
    if (!role) {
      await message.reply(`❌ Tag atau masukkan ID role yang valid. Contoh: \`${p}cmdrole ${sub} @Admin\``);
      return true;
    }

    if (sub === 'add') {
      addCommandRole(message.guildId, role.id, role.name);
      await message.reply(`✅ Role **@${role.name}** sekarang **diizinkan** menggunakan command bot.`);
      return true;
    }
    if (sub === 'remove' || sub === 'del') {
      const removed = removeCommandRole(message.guildId, role.id);
      await message.reply(
        removed
          ? `🗑️ Izin command untuk role **@${role.name}** dicabut.`
          : `⚠️ Role **@${role.name}** tidak ada dalam daftar.`
      );
      return true;
    }
    return true;
  }

  // ==========================================
  // 8. gtargetrole
  // ==========================================
  if (command === 'targetrole') {
    if (!getSetting('main_guild_id')) setSetting('main_guild_id', message.guildId);
    const sub = (args[0] || 'list').toLowerCase();

    if (sub === 'list') {
      const roles = getTrackedRoles(targetGuildId);
      const text = roles.length
        ? roles.map((r, i) => `\`${i + 1}.\` <@&${r.role_id}> (**@${r.role_name}**)`).join('\n')
        : `> ℹ️ Belum ada role yang dilacak. Gunakan \`${p}targetrole add @role\`.`;
      await message.reply({
        embeds: [new EmbedBuilder().setColor(THEME.PRIMARY).setTitle(`🎭 Role Target Pelacakan (${roles.length})`).setDescription(text)],
      });
      return true;
    }

    const roleId = extractSnowflake(args[1]);
    const role = message.mentions.roles.first() || (roleId ? message.guild.roles.cache.get(roleId) : null);
    if (!role) {
      await message.reply(`❌ Tag atau masukkan ID role yang valid. Contoh: \`${p}targetrole ${sub} @Staff\``);
      return true;
    }

    if (sub === 'add') {
      addTrackedRole(targetGuildId, role.id, role.name);
      await message.reply(`✅ Role **@${role.name}** ditambahkan ke daftar pelacakan General Chat.`);
      return true;
    }
    if (sub === 'remove' || sub === 'del') {
      const removed = removeTrackedRole(targetGuildId, role.id);
      await message.reply(
        removed
          ? `🗑️ Role **@${role.name}** dihapus dari daftar pelacakan.`
          : `⚠️ Role **@${role.name}** tidak ada dalam daftar pelacakan.`
      );
      return true;
    }
    return true;
  }

  // ==========================================
  // 9. gtargetuser
  // ==========================================
  if (command === 'targetuser') {
    if (!getSetting('main_guild_id')) setSetting('main_guild_id', message.guildId);
    const sub = (args[0] || 'list').toLowerCase();

    if (sub === 'list') {
      const users = getTrackedUsers(targetGuildId);
      const text = users.length
        ? users.map((u, i) => `\`${i + 1}.\` <@${u.user_id}> (**${u.username}**)`).join('\n')
        : `> ℹ️ Belum ada user spesifik tambahan.`;
      await message.reply({
        embeds: [new EmbedBuilder().setColor(THEME.PRIMARY).setTitle(`👤 User Target Spesifik (${users.length})`).setDescription(text)],
      });
      return true;
    }

    const uid = extractSnowflake(args[1]);
    const user = message.mentions.users.first() || (uid ? await client.users.fetch(uid).catch(() => null) : null);
    if (!user) {
      await message.reply(`❌ Tag atau masukkan ID user yang valid. Contoh: \`${p}targetuser ${sub} @User\``);
      return true;
    }

    if (sub === 'add') {
      addTrackedUser(targetGuildId, user.id, user.tag);
      await message.reply(`✅ User **${user.tag}** ditambahkan ke daftar pelacakan khusus.`);
      return true;
    }
    if (sub === 'remove' || sub === 'del') {
      const removed = removeTrackedUser(targetGuildId, user.id);
      await message.reply(
        removed
          ? `🗑️ User **${user.tag}** dihapus dari daftar pelacakan.`
          : `⚠️ User **${user.tag}** tidak ditemukan.`
      );
      return true;
    }
    return true;
  }

  // ==========================================
  // 10. gchannel
  // ==========================================
  if (command === 'channel') {
    if (!getSetting('main_guild_id')) setSetting('main_guild_id', message.guildId);
    const sub = (args[0] || 'list').toLowerCase();

    if (sub === 'list') {
      const channels = getTrackedChannels(targetGuildId);
      const text = channels.length
        ? channels.map((c, i) => `\`${i + 1}.\` <#${c.channel_id}> (**#${c.channel_name}**)`).join('\n')
        : `> ℹ️ Belum ada filter channel (memantau semua channel di Server Utama).`;
      await message.reply({
        embeds: [new EmbedBuilder().setColor(THEME.PRIMARY).setTitle(`💬 Channel yang Dipantau (${channels.length})`).setDescription(text)],
      });
      return true;
    }

    const cid = extractSnowflake(args[1]);
    const chan = message.mentions.channels.first() || (cid ? message.guild.channels.cache.get(cid) : null);
    if (!chan) {
      await message.reply(`❌ Tag atau masukkan ID channel yang valid. Contoh: \`${p}channel ${sub} #general-chat\``);
      return true;
    }

    if (sub === 'add') {
      addTrackedChannel(targetGuildId, chan.id, chan.name);
      await message.reply(`✅ Channel **#${chan.name}** ditambahkan ke daftar pantauan.`);
      return true;
    }
    if (sub === 'remove' || sub === 'del') {
      const removed = removeTrackedChannel(targetGuildId, chan.id);
      await message.reply(
        removed
          ? `🗑️ Channel **#${chan.name}** dihapus dari daftar pantauan.`
          : `⚠️ Channel **#${chan.name}** tidak ada dalam daftar pantauan.`
      );
      return true;
    }
    return true;
  }

  // ==========================================
  // 11. greset
  // ==========================================
  if (command === 'reset') {
    const scope = (args[0] || '').toLowerCase();
    if (!['today', 'user', 'all'].includes(scope)) {
      await message.reply(`❌ Format: \`${p}reset <today|user|all> [@user]\``);
      return true;
    }

    let userId = null;
    if (scope === 'user') {
      userId = message.mentions.users.first()?.id || extractSnowflake(args[1]);
      if (!userId) {
        await message.reply(`❌ Sebutkan user yang ingin direset. Contoh: \`${p}reset user @Admin\``);
        return true;
      }
    }

    const deletedCount = resetLogs({
      guildId: targetGuildId,
      scope,
      userId,
      dateWib: getDateWIB(),
    });

    await message.reply(`🧹 Berhasil mereset **${deletedCount} data bukti log** (Cakupan: \`${scope}\`).`);
    return true;
  }

  return true;
}

module.exports = {
  parsePrefixCommand,
  handlePrefixCommand,
};

