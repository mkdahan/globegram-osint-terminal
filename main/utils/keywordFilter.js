/**
 * High-priority keyword filter (multilingual: en/he/ar/ru).
 * A message matching any keyword triggers immediate media download and
 * a red-flagged event; otherwise media download is on-demand.
 */
'use strict';

const KEYWORDS = {
  explosion: ['explosion', 'blast', 'פיצוץ', 'פיצוצים', 'התפוצצות', 'انفجار', 'انفجارات', 'взрыв', 'взрывы'],
  missile: ['missile', 'rocket', 'ballistic', 'טיל', 'טילים', 'רקטה', 'רקטות', 'صاروخ', 'صواريخ', 'ракета', 'ракеты', 'баллистическая'],
  strike: [
    'strike', 'airstrike', 'air strike', 'shelling', 'bombardment',
    'תקיפה', 'תקיפת', 'תקיפות', 'הפצצה', 'הפגזה', 'הפגזות', 'דחיפות', 'ארטילריה',
    'غارة', 'قصف', 'удар', 'авиаудар', 'обстрел', 'обстрелы',
  ],
  attack: ['attack', 'פיגוע', 'מתקפה', 'הותקף', 'תקפו', 'תקף', 'שיירה', 'هجوم', 'اعتداء', 'атака', 'нападение', 'колонн'],
  fire: ['fire', 'burning', 'שריפה', 'שרפה', 'בוער', 'حريق', 'حرائق', 'пожар'],
  sirens: ['siren', 'sirens', 'אזעקה', 'אזעקות', 'צבע אדום', 'صفارات الإنذار', 'صافرات', 'сирена', 'тревога'],
  earthquake: ['earthquake', 'רעידת אדמה', 'רעש אדמה', 'زلزال', 'هزة أرضية', 'землетрясение'],
  drone: ['drone', 'uav', 'כטב"ם', 'כטבם', 'כלי טיס בלתי מאויש', 'מל"ט', 'مسيرة', 'طائرة مسيرة', 'дрон', 'беспилотник', 'бпла'],
  interception: ['intercepted', 'interception', 'יירוט', 'יורט', 'כיפת ברזל', 'اعتراض', 'перехват'],
  casualties: [
    'killed', 'wounded', 'casualties', 'dead',
    'הרוג', 'הרוגים', 'פצוע', 'פצועים', 'נפגעים',
    'قتلى', 'جرحى', 'شهداء', 'убит', 'погибли', 'раненые', 'ранен',
  ],
  evacuation: ['evacuation', 'evacuate', 'פינוי', 'התפנו', 'إخلاء', 'эвакуация'],
  gunfire: ['gunfire', 'shooting', 'ירי', 'יריות', 'إطلاق نار', 'стрельба'],
};

const FLAT = [];
for (const [category, words] of Object.entries(KEYWORDS)) {
  for (const w of words) FLAT.push({ category, word: w.toLowerCase() });
}

/**
 * @returns {{highPriority: boolean, matches: [{category, word}]}}
 */
function classify(text) {
  if (!text) return { highPriority: false, matches: [] };
  const lower = String(text).toLowerCase();
  const matches = [];
  const seen = new Set();
  for (const { category, word } of FLAT) {
    if (!seen.has(category) && lower.includes(word)) {
      matches.push({ category, word });
      seen.add(category);
    }
  }
  return { highPriority: matches.length > 0, matches };
}

module.exports = { classify, KEYWORDS };
