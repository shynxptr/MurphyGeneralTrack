/**
 * Modul Validasi Pesan & Anti-Spam
 * Memastikan pesan memenuhi syarat minimal kata (default: 4 kata)
 * dan bukan merupakan spam/duplikat/command bot.
 */

const COMMAND_PREFIXES = ['!', '/', '.', '?', '$', '-', '~', '>'];

/**
 * Membersihkan teks dari URL, mention Discord, custom emoji, dan emoji unicode
 * agar perhitungan jumlah kata akurat dan tidak bisa diakali.
 *
 * @param {string} rawContent
 * @returns {string}
 */
function cleanMessageContent(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';

  return rawContent
    // Hapus URL (http/https/www/discord.gg)
    .replace(/https?:\/\/\S+|www\.\S+|discord\.gg\/\S+/gi, ' ')
    // Hapus mention user, role, atau channel (<@123>, <@!123>, <@&123>, <#123>)
    .replace(/<(@!?|@&|#)\d+>/g, ' ')
    // Hapus custom emoji Discord (<:nama:123> atau <a:nama:123>)
    .replace(/<a?:[a-zA-Z0-9_]+:\d+>/g, ' ')
    // Hapus emoji unicode standar & simbol piktograf
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, ' ')
    // Hapus karakter tanda baca berlebih (sisakan huruf, angka, dan spasi)
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    // Rapikan spasi ganda
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mengecek apakah sebuah kata adalah spam karakter berulang (contoh: "wkwkwkwk" masih wajar jika bervariasi,
 * tapi "aaaaaaaaaa" atau "1111111" atau karakter tunggal "a" dianggap tidak valid jika mayoritas).
 *
 * @param {string} word
 * @returns {boolean}
 */
function isGibberishWord(word) {
  // Kata yang hanya terdiri dari 1 karakter berulang terus menerus >= 4 kali (misal: "aaaaa", "zzzzz")
  if (/^(.)\1{3,}$/i.test(word)) {
    return true;
  }
  return false;
}

/**
 * Memvalidasi apakah pesan layak dihitung ke dalam tracker.
 *
 * @param {string} content - Isi pesan asli
 * @param {object} options
 * @param {number} [options.minWords=4] - Jumlah kata minimal
 * @param {string|null} [options.lastMessageContent=null] - Isi pesan valid terakhir dari user yang sama
 * @returns {{ valid: boolean, wordCount: number, cleanWords: string[], reason?: string }}
 */
function validateMessage(content, options = {}) {
  const minWords = options.minWords ?? 4;
  const lastMessageContent = options.lastMessageContent ?? null;

  if (!content || typeof content !== 'string') {
    return { valid: false, wordCount: 0, cleanWords: [], reason: 'Pesan kosong atau hanya berisi media/lampiran.' };
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return { valid: false, wordCount: 0, cleanWords: [], reason: 'Pesan kosong.' };
  }

  // 1. Abaikan command bot
  if (COMMAND_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return { valid: false, wordCount: 0, cleanWords: [], reason: 'Terdeteksi sebagai command bot.' };
  }

  // 2. Bersihkan URL, mention, dan emoji
  const cleaned = cleanMessageContent(trimmed);
  if (!cleaned) {
    return { valid: false, wordCount: 0, cleanWords: [], reason: 'Pesan hanya berisi emoji, link, atau mention.' };
  }

  // Pisahkan kata dan buang kata yang terlalu pendek (1 huruf saja seperti "a b c d")
  const rawWords = cleaned.split(' ').filter(Boolean);

  // Filter kata yang valid (minimal 2 karakter, atau angka/kata umum yang tidak seluruhnya 1 huruf sampah)
  const validWords = rawWords.filter((w) => !isGibberishWord(w));

  // Cek jika mayoritas kata hanya 1 karakter (misal: "a b c d e")
  const multiCharWords = validWords.filter((w) => w.length >= 2);
  if (multiCharWords.length < Math.ceil(minWords * 0.75)) {
    return {
      valid: false,
      wordCount: validWords.length,
      cleanWords: validWords,
      reason: `Terlalu banyak kata 1 huruf/tidak bermakna (minimal ${minWords} kata utuh).`,
    };
  }

  // 3. Cek minimal jumlah kata (Default: 4 kata)
  if (validWords.length < minWords) {
    return {
      valid: false,
      wordCount: validWords.length,
      cleanWords: validWords,
      reason: `Jumlah kata kurang dari batas minimal (${validWords.length}/${minWords} kata).`,
    };
  }

  // 4. Anti-Spam: Cek pengulangan kata yang sama dalam satu pesan (contoh: "tes tes tes tes" atau "halo halo halo halo")
  const normalizedWords = validWords.map((w) => w.toLowerCase());
  const uniqueWords = new Set(normalizedWords);

  // Untuk pesan >= 4 kata, minimal harus ada 3 kata unik (atau rasio kata unik >= 50%)
  const minUniqueRequired = Math.min(3, Math.ceil(minWords * 0.6));
  if (uniqueWords.size < minUniqueRequired || uniqueWords.size / normalizedWords.length < 0.5) {
    return {
      valid: false,
      wordCount: validWords.length,
      cleanWords: validWords,
      reason: 'Terdeteksi spam pengulangan kata yang sama.',
    };
  }

  // 5. Anti-Spam: Cek duplikat persis dengan pesan valid terakhir milik user tersebut
  if (lastMessageContent) {
    const prevCleaned = cleanMessageContent(lastMessageContent).toLowerCase();
    const currentCleaned = cleaned.toLowerCase();
    if (prevCleaned && prevCleaned === currentCleaned) {
      return {
        valid: false,
        wordCount: validWords.length,
        cleanWords: validWords,
        reason: 'Pesan duplikat (sama persis dengan pesan sebelumnya).',
      };
    }
  }

  return {
    valid: true,
    wordCount: validWords.length,
    cleanWords: validWords,
  };
}

module.exports = {
  cleanMessageContent,
  validateMessage,
};

