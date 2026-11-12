require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
} = require('discord.js');

const {
  getConfig,
  getTrackedRoles,
  getTrackedUsers,
  getTrackedChannels,
  getLastUserMessage,
  getLogByMessageId,
  removeMessageLogById,
  updateMessageLogById,
  recordMessageLog,
  formatDateTimeWIB,
} = require('./database');

const { validateMessage } = require('./validator');
const { THEME, getProgressStatus, buildProgressBar } = require('./utils');
const { commandDefinitions, handleInteraction } = require('./commands');
const { startScheduler } = require('./scheduler');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// State memori untuk Filter Anti-Monolog & Cooldown jeda pesan
const channelLastAuthor = new Map(); // channelId -> { userId, streak }
const userLastValidTime = new Map(); // `${guildId}:${userId}` -> timestampMs

// Sinkronisasi Slash Commands otomatis saat bot menyala
client.once(Events.ClientReady, async (readyClient) => {
  console.log('====================================================');
  console.log(`🤖 Bot Aktif sebagai: ${readyClient.user.tag}`);
  console.log(`🏠 Terhubung ke ${readyClient.guilds.cache.size} server`);

  try {
    const body = commandDefinitions.map((cmd) => cmd.toJSON());
    await readyClient.application.commands.set(body);
    console.log(`✅ ${body.length} Slash Commands siap digunakan!`);
  } catch (err) {
    console.error('⚠️ Gagal menyinkronkan Slash Commands:', err.message);
  }

  const cfg = getConfig();
  console.log(`🎯 Target Harian Aktif : ${cfg.dailyTarget} pesan/hari (Min. ${cfg.minWords} kata)`);
  console.log(
    `📡 Channel Server Log  : ${
      cfg.logChannelId ? cfg.logChannelId : 'Belum diset (Tracker tetap berjalan & menyimpan ke DB)'
    }`
  );
  console.log(
    `📑 Tutup Buku Otomatis : ${cfg.autoRecap ? 'Aktif (Tiap 00:00 WIB + CSV)' : 'Nonaktif'}`
  );
  console.log(
    `⏰ Auto-Reminder Malam : ${
      cfg.reminderEnabled ? `Aktif (Tiap ${String(cfg.reminderHour).padStart(2, '0')}:00 WIB)` : 'Nonaktif'
    }`
  );
  console.log('====================================================');

  startScheduler(readyClient);
});

// Handler untuk Slash Commands & Tombol Interaktif
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await handleInteraction(interaction, client);
  } catch (error) {
    console.error('❌ Error saat menjalankan interaksi:', error);
    const msg = {
      content: '❌ Terjadi kesalahan internal saat memproses perintah.',
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => null);
    } else {
      await interaction.reply(msg).catch(() => null);
    }
  }
});

// Handler Utama Pelacakan Pesan General Chat
client.on(Events.MessageCreate, async (message) => {
  try {
    // 1. Abaikan pesan dari bot, webhook, sistem, atau DM
    if (!message.guild || message.author.bot || message.webhookId || message.system) {
      return;
    }

    const cfg = getConfig();

    // Jika Server Utama sudah dikunci di config, abaikan pesan dari server lain (misal dari Server Khusus Log)
    if (cfg.mainGuildId && message.guild.id !== cfg.mainGuildId) {
      return;
    }

    // 2. Cek apakah channel ini termasuk channel yang dilacak (jika daftar channel sudah diatur)
    const trackedChannels = getTrackedChannels(message.guild.id);
    if (trackedChannels.length > 0) {
      const isChannelTracked = trackedChannels.some((c) => c.channel_id === message.channel.id);
      if (!isChannelTracked) return;
    }

    // Jika orang lain (termasuk member biasa) mengirim chat di channel ini, reset streak monolog user sebelumnya
    const prevChannelState = channelLastAuthor.get(message.channel.id);
    if (!prevChannelState || prevChannelState.userId !== message.author.id) {
      channelLastAuthor.set(message.channel.id, { userId: message.author.id, streak: 0 });
    }

    // 3. Cek apakah pengirim termasuk Role atau User yang dilacak
    const trackedRoles = getTrackedRoles(message.guild.id);
    const trackedUsers = getTrackedUsers(message.guild.id);

    // Jika belum ada role maupun user yang diset sama sekali, jangan lacak sembarang orang
    if (trackedRoles.length === 0 && trackedUsers.length === 0) {
      return;
    }

    const isTrackedUser = trackedUsers.some((u) => u.user_id === message.author.id);

    let member = message.member;
    if (!member) {
      member = await message.guild.members.fetch(message.author.id).catch(() => null);
    }

    const matchedRole = trackedRoles.find((r) => member?.roles?.cache?.has(r.role_id));

    if (!isTrackedUser && !matchedRole) {
      return;
    }

    // 4. Filter Cooldown Jeda Pesan & Anti-Monolog (Cegah kejar setoran chat beruntun sendirian)
    const userCooldownKey = `${message.guild.id}:${message.author.id}`;
    const lastValidTs = userLastValidTime.get(userCooldownKey) || 0;
    const msgTs = message.createdTimestamp || Date.now();

    if (cfg.cooldownSeconds > 0 && msgTs - lastValidTs < cfg.cooldownSeconds * 1000) {
      return;
    }

    const currentChanState = channelLastAuthor.get(message.channel.id);
    if (
      cfg.maxConsecutive > 0 &&
      currentChanState &&
      currentChanState.userId === message.author.id &&
      currentChanState.streak >= cfg.maxConsecutive
    ) {
      return;
    }

    // 5. Validasi minimal jumlah kata (default: 4 kata) & filter Anti-Spam/Duplikat
    const lastMsg = getLastUserMessage(message.guild.id, message.author.id);
    const validation = validateMessage(message.content, {
      minWords: cfg.minWords,
      lastMessageContent: lastMsg ? lastMsg.content : null,
    });

    if (!validation.valid) {
      return;
    }

    // Perbarui state Cooldown & Anti-Monolog setelah pesan dinyatakan valid
    userLastValidTime.set(userCooldownKey, msgTs);
    channelLastAuthor.set(message.channel.id, {
      userId: message.author.id,
      streak: (currentChanState?.userId === message.author.id ? currentChanState.streak : 0) + 1,
    });

    // 6. Simpan bukti pesan ke database SQLite (Tetap berjalan walau server log belum diset!)
    const recordResult = recordMessageLog({
      messageId: message.id,
      guildId: message.guild.id,
      channelId: message.channel.id,
      channelName: message.channel.name || 'general',
      userId: message.author.id,
      userTag: message.author.tag,
      content: message.content,
      wordCount: validation.wordCount,
      messageUrl: message.url,
      createdAt: message.createdTimestamp,
    });

    const { dailyCount, dailyWords, dateWib } = recordResult;
    const isTargetJustReached = dailyCount === cfg.dailyTarget;
    const status = getProgressStatus(dailyCount, cfg.dailyTarget);

    // 6. Jika Channel Log (di Server Khusus Log) sudah diset, kirim bukti log real-time
    if (cfg.logChannelId) {
      const logChannel = await client.channels.fetch(cfg.logChannelId).catch(() => null);
      if (logChannel && logChannel.isTextBased()) {
        const progressBar = buildProgressBar(dailyCount, cfg.dailyTarget, 12);
        const roleBadge = matchedRole ? `@${matchedRole.role_name}` : 'User Khusus';
        const remaining = Math.max(0, cfg.dailyTarget - dailyCount);

        const contentPreview =
          message.content.length > 450
            ? `${message.content.slice(0, 450)}...`
            : message.content;

        const logEmbed = new EmbedBuilder()
          .setAuthor({
            name: `${message.author.tag} • [${roleBadge}]`,
            iconURL: message.author.displayAvatarURL(),
          })
          .setTitle(
            isTargetJustReached
              ? '🎉 MILESTONE TARGET HARIAN TERCAPAI!'
              : '📡 Live Log • Pesan General Chat Tercatat'
          )
          .setThumbnail(message.author.displayAvatarURL({ size: 128 }))
          .setColor(isTargetJustReached ? THEME.GOLD : status.color)
          .setDescription(
            `**💬 Isi Pesan Valid:**\n` +
            `\`\`\`\n${contentPreview.replace(/```/g, "'''")}\n\`\`\`\n` +
            `**🎯 Progress Target Harian (${dateWib} WIB)**\n` +
            `> ${progressBar}\n` +
            `> ${
              remaining === 0
                ? `✅ **Target ${cfg.dailyTarget} pesan hari ini telah tuntas!**`
                : `⏳ Kurang **${remaining} pesan** lagi menuju target harian.`
            }`
          )
          .addFields(
            {
              name: '👤 Pengirim',
              value: `<@${message.author.id}>\n\`${message.author.id}\``,
              inline: true,
            },
            {
              name: '📍 Lokasi Chat',
              value: `<#${message.channel.id}>\n*${message.guild.name}*`,
              inline: true,
            },
            {
              name: '📝 Statistik Kata',
              value: `**+${validation.wordCount} Kata Valid**\nTotal: \`${dailyWords} kata\``,
              inline: true,
            }
          )
          .setFooter({
            text: `ID Pesan: ${message.id} • ${formatDateTimeWIB(new Date(message.createdTimestamp))} WIB`,
          });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel('Lihat Bukti Pesan di Discord')
            .setStyle(ButtonStyle.Link)
            .setURL(message.url)
            .setEmoji('🔗'),
          new ButtonBuilder()
            .setCustomId(`stats_logs:${message.author.id}:${dateWib}`)
            .setLabel('Riwayat Log User Ini')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📋')
        );

        await logChannel.send({ embeds: [logEmbed], components: [row] }).catch((err) => {
          console.warn(`⚠️ Gagal mengirim log ke channel ${cfg.logChannelId}:`, err.message);
        });
      }
    }
  } catch (error) {
    console.error('❌ Error pada event MessageCreate:', error);
  }
});

// Proteksi Anti-Curang: Batalkan poin jika pesan yang sudah dihitung dihapus
client.on(Events.MessageDelete, async (message) => {
  try {
    if (!message.id) return;
    const result = removeMessageLogById(message.id);
    if (!result) return;

    const cfg = getConfig();
    if (cfg.logChannelId) {
      const logChannel = await client.channels.fetch(cfg.logChannelId).catch(() => null);
      if (logChannel && logChannel.isTextBased()) {
        const { removedLog, dailyCount } = result;
        const progressBar = buildProgressBar(dailyCount, cfg.dailyTarget, 12);

        const alertEmbed = new EmbedBuilder()
          .setTitle('🗑️ Poin Dibatalkan • Pesan Dihapus')
          .setColor(THEME.DANGER)
          .setDescription(
            `Pesan dari <@${removedLog.user_id}> (**${removedLog.user_tag}**) di <#${removedLog.channel_id}> telah dihapus sehingga poin dikurangi **-1**.\n\n` +
            `**Isi Pesan yang Dihapus:**\n` +
            `\`\`\`\n${removedLog.content.slice(0, 350).replace(/```/g, "'''")}\n\`\`\`\n` +
            `**🎯 Progress Terbaru (${removedLog.date_wib} WIB):**\n> ${progressBar}`
          )
          .setFooter({ text: `ID Pesan: ${removedLog.message_id}` })
          .setTimestamp();

        await logChannel.send({ embeds: [alertEmbed] }).catch(() => null);
      }
    }
  } catch (error) {
    console.error('❌ Error pada event MessageDelete:', error);
  }
});

// Proteksi Anti-Curang: Evaluasi ulang jika pesan yang sudah dihitung diedit menjadi < 4 kata
client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
  try {
    if (!newMessage.id) return;
    if (newMessage.partial) {
      newMessage = await newMessage.fetch().catch(() => null);
      if (!newMessage) return;
    }
    if (!newMessage.content) return;
    const existing = getLogByMessageId(newMessage.id);
    if (!existing) return;

    const cfg = getConfig();
    const validation = validateMessage(newMessage.content, { minWords: cfg.minWords });

    if (!validation.valid) {
      const result = removeMessageLogById(newMessage.id);
      if (result && cfg.logChannelId) {
        const logChannel = await client.channels.fetch(cfg.logChannelId).catch(() => null);
        if (logChannel && logChannel.isTextBased()) {
          const { removedLog, dailyCount } = result;
          const progressBar = buildProgressBar(dailyCount, cfg.dailyTarget, 12);

          const alertEmbed = new EmbedBuilder()
            .setTitle('⚠️ Poin Dibatalkan • Pesan Diedit Tidak Valid')
            .setColor(THEME.WARNING)
            .setDescription(
              `Pesan dari <@${removedLog.user_id}> di <#${removedLog.channel_id}> diedit menjadi kurang dari **${cfg.minWords} kata valid** sehingga poin dibatalkan.\n\n` +
              `**Isi Setelah Diedit:**\n` +
              `\`\`\`\n${newMessage.content.slice(0, 350).replace(/```/g, "'''")}\n\`\`\`\n` +
              `**🎯 Progress Terbaru (${removedLog.date_wib} WIB):**\n> ${progressBar}`
            )
            .setFooter({ text: `ID Pesan: ${removedLog.message_id}` })
            .setTimestamp();

          await logChannel.send({ embeds: [alertEmbed] }).catch(() => null);
        }
      }
    } else {
      updateMessageLogById(newMessage.id, newMessage.content, validation.wordCount);
    }
  } catch (error) {
    console.error('❌ Error pada event MessageUpdate:', error);
  }
});

// Validasi Token sebelum login
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN belum diatur! Silakan salin .env.example menjadi .env dan isi token bot kamu.');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
