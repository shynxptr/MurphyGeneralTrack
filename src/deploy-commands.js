require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { commandDefinitions } = require('./commands');

async function deployCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;

  if (!token || !clientId) {
    console.error('❌ Harap isi DISCORD_TOKEN dan CLIENT_ID di file .env terlebih dahulu!');
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const body = commandDefinitions.map((cmd) => cmd.toJSON());

  try {
    console.log(`⏳ Mendaftarkan ${body.length} Slash Commands secara global...`);
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log('✅ Seluruh Slash Commands berhasil didaftarkan!');
  } catch (error) {
    console.error('❌ Gagal mendaftarkan Slash Commands:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  deployCommands();
}

module.exports = { deployCommands };

