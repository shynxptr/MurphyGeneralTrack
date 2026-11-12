/**
 * Utilitas Visual UI/UX Discord & Generator CSV
 */

const THEME = {
  PRIMARY: 0x5865f2,   // Royal Blurple
  SUCCESS: 0x2ecc71,   // Emerald Green
  WARNING: 0xf39c12,   // Amber Gold
  DANGER: 0xed4245,    // Crimson Red
  INFO: 0x00b0f4,      // Sky Cyan
  GOLD: 0xf1c40f,      // Milestone Gold
  DARK: 0x2b2d31,      // Discord Dark Card
};

const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

/**
 * Mengembalikan badge status visual berdasarkan progress target harian
 * @param {number} current
 * @param {number} target
 * @returns {{ icon: string, label: string, color: number }}
 */
function getProgressStatus(current, target) {
  if (target <= 0 || current >= target) {
    return { icon: '✅', label: 'TARGET TERCAPAI', color: THEME.SUCCESS };
  }
  const pct = (current / target) * 100;
  if (pct >= 75) {
    return { icon: '🔥', label: 'HAMPIR SELESAI', color: THEME.GOLD };
  }
  if (pct >= 25) {
    return { icon: '⏳', label: 'SEDANG BERJALAN', color: THEME.WARNING };
  }
  if (current > 0) {
    return { icon: '🌱', label: 'BARU MULAI', color: THEME.INFO };
  }
  return { icon: '💤', label: 'BELUM ADA PESAN', color: THEME.DANGER };
}

/**
 * Membuat progress bar visual modern untuk target pesan harian
 * Contoh: 🔥 `▰▰▰▰▰▰▱▱▱▱` **60/100** (60%)
 *
 * @param {number} current
 * @param {number} target
 * @param {number} [length=10]
 * @returns {string}
 */
function buildProgressBar(current, target, length = 10) {
  if (target <= 0) return `**${current}** pesan`;
  const ratio = Math.min(1, Math.max(0, current / target));
  const filled = Math.round(ratio * length);
  const empty = length - filled;
  const percentage = Math.round((current / target) * 100);
  const bar = '▰'.repeat(filled) + '▱'.repeat(empty);
  const { icon } = getProgressStatus(current, target);
  return `${icon} \`${bar}\` **${current}/${target}** (${percentage}%)`;
}

/**
 * Mengonversi array log menjadi format CSV yang aman dibuka di Excel / Google Sheets
 * @param {Array<object>} logs
 * @param {number} dailyTarget
 * @returns {string}
 */
function generateLogsCsv(logs, dailyTarget) {
  const escapeCsv = (val) => {
    const str = String(val ?? '').replace(/"/g, '""');
    return `"${str}"`;
  };

  const headers = [
    'No',
    'Tanggal (WIB)',
    'Waktu (ISO)',
    'User Tag',
    'User ID',
    'Channel',
    'Jumlah Kata',
    'Target Harian',
    'Isi Pesan',
    'Bukti Link Discord',
  ];

  const rows = logs.map((row, idx) => [
    idx + 1,
    row.date_wib,
    new Date(row.created_at).toISOString(),
    row.user_tag,
    row.user_id,
    `#${row.channel_name}`,
    row.word_count,
    dailyTarget,
    row.content,
    row.message_url,
  ]);

  // Tambahkan UTF-8 BOM agar Microsoft Excel membaca emoji & karakter khusus dengan benar
  return (
    '\uFEFF' +
    [
      headers.map(escapeCsv).join(','),
      ...rows.map((r) => r.map(escapeCsv).join(',')),
    ].join('\r\n')
  );
}

/**
 * Merapikan cuplikan teks pesan untuk ditampilkan di dalam embed (1 baris, aman dari markdown)
 * @param {string} text
 * @param {number} [maxLen=65]
 * @returns {string}
 */
function formatSnippet(text, maxLen = 65) {
  const singleLine = String(text ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, maxLen)}...`;
}

/**
 * Menggabungkan baris teks agar tidak melebihi batas karakter Discord (misal 4096 untuk description, 1024 untuk field)
 * tanpa memotong tag mention/markdown di tengah baris.
 * @param {string[]} lines
 * @param {number} maxLength
 * @param {string} [separator='\n']
 * @param {string} [overflowNote='\n...*(dan lainnya)*']
 * @returns {string}
 */
function joinLinesWithinLimit(lines, maxLength, separator = '\n', overflowNote = '\n...*(dan lainnya)*') {
  let result = '';
  for (let i = 0; i < lines.length; i++) {
    const piece = (result ? separator : '') + lines[i];
    const hasMore = i < lines.length - 1;
    const reserve = hasMore ? overflowNote.length : 0;
    if (result.length + piece.length + reserve > maxLength) {
      return result ? result + overflowNote : lines[i].slice(0, maxLength - 3) + '...';
    }
    result += piece;
  }
  return result;
}

module.exports = {
  THEME,
  DIVIDER,
  getProgressStatus,
  buildProgressBar,
  generateLogsCsv,
  formatSnippet,
  joinLinesWithinLimit,
};
