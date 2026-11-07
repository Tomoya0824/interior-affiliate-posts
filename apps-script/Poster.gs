/**
 * Room Totonoe — 毎日の自動投稿
 *
 * postDaily     … 楽天の売れ筋から未投稿の商品を1つ選び、Threadsに画像付きで投稿する
 * previewDaily  … 投稿はせず、選ばれる商品と投稿文をログで確認する
 * setupDailyTrigger … 毎日20時台に postDaily を実行するトリガーを作る（一度だけ）
 */

// 商品を選ぶ条件
const PICK_RULES = {
  minReviewCount: 30,
  minReviewAverage: 4.0,
  minPrice: 1000,
  maxPrice: 30000
};

// 曜日ごとの担当ジャンル（日〜土）。インテリア中心、キッチンを週2回
const GENRE_SCHEDULE = ['interior', 'interior', 'kitchen', 'interior', 'interior', 'kitchen', 'interior'];

// 体への効果をうたう表現は使わない（薬機法対策）。商品名にあれば削る
const NG_WORDS = ['肩こり', '腰痛', '改善', '治る', '効く', '解消', '安眠', '快眠', '痩せ', 'ダイエット', '美肌', '医療', '治療'];

function todayGenre_() {
  const key = GENRE_SCHEDULE[new Date().getDay()];
  return GENRES[key];
}

function postedCodes_() {
  try { return JSON.parse(props_().getProperty('POSTED_CODES') || '[]'); } catch (e) { return []; }
}

function rememberPosted_(code) {
  const codes = postedCodes_();
  codes.push(code);
  // 直近300件だけ覚えておく
  props_().setProperty('POSTED_CODES', JSON.stringify(codes.slice(-300)));
}

/** 条件に合う未投稿の商品を1つ選ぶ */
function pickItem_(genre) {
  const posted = postedCodes_();
  for (let page = 1; page <= 3; page++) {
    const items = searchRakutenItems({
      genreId: genre.id,
      sort: '-reviewCount',
      hits: 30,
      page: page,
      minPrice: PICK_RULES.minPrice,
      maxPrice: PICK_RULES.maxPrice
    });
    const candidates = items.filter(function (it) {
      return it.images.length > 0 &&
        it.reviewCount >= PICK_RULES.minReviewCount &&
        it.reviewAverage >= PICK_RULES.minReviewAverage &&
        posted.indexOf(it.code) < 0;
    });
    if (candidates.length) {
      // 上位から順に出すと偏るので、候補の中からランダムに選ぶ
      return candidates[Math.floor(Math.random() * Math.min(candidates.length, 10))];
    }
  }
  throw new Error('条件に合う未投稿の商品が見つかりませんでした（' + genre.label + '）');
}

// 商品名から外す単語（サイズ・型番・宣伝文句など）
const SIZE_WORDS = ['シングル', 'セミシングル', 'セミダブル', 'ダブル', 'クイーン', 'キング', 'ワイドダブル'];
const NOISE_PATTERNS = [
  /^\d+点セット$/, /^[A-Za-z]{0,3}-?\d{2,}[A-Za-z]?$/, /\d+(\.\d+)?(cm|mm|m|kg|g|L|ml)$/i,
  /送料無料/, /ポイント\d*倍?/, /楽天\d*位/, /ランキング/, /^公式$/, /^安心$/, /^清潔$/, /^SALE$/i,
  /^クーポン/, /^あす楽/, /^限定/, /^新作$/, /^新色$/, /^母の日$/, /^父の日$/, /^ギフト$/, /^プレゼント$/
];

function cleanTokens_(name) {
  let s = String(name)
    .replace(/【[^】]*】/g, ' ')
    .replace(/［[^］]*］|\[[^\]]*\]|＜[^＞]*＞|<[^>]*>/g, ' ')
    .replace(/[★☆◆◇■□●○♪＼／\\/!！|｜]+/g, ' ');
  NG_WORDS.forEach(function (w) { s = s.split(w).join(' '); });
  const seen = {};
  return s.split(/[\s　]+/).filter(function (t) {
    if (!t || seen[t]) return false;
    seen[t] = true;
    return true;
  });
}

/** 長い楽天の商品名を、投稿向けの短い名前にする（単語の途中では切らない） */
function shortName_(name) {
  const tokens = cleanTokens_(name).filter(function (t) {
    if (SIZE_WORDS.indexOf(t) >= 0) return false;
    return !NOISE_PATTERNS.some(function (re) { return re.test(t); });
  });
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const next = out ? out + ' ' + tokens[i] : tokens[i];
    if (next.length > 24 && out) break;
    out = next;
  }
  return out || String(name).slice(0, 24);
}

/** 商品名に含まれるサイズ展開（例：シングル／セミダブル／ダブル） */
function sizeLine_(name) {
  const found = SIZE_WORDS.filter(function (w) { return cleanTokens_(name).indexOf(w) >= 0; });
  return found.length >= 2 ? '選べるサイズ：' + found.join('／') : '';
}

/** 投稿文を作る（Threadsは500文字まで） */
function buildPostText_(item, genre) {
  const sizes = sizeLine_(item.name);
  const lines = [
    '#PR ' + shortName_(item.name),
    '',
    '★' + item.reviewAverage.toFixed(2) + '（レビュー' + item.reviewCount.toLocaleString('ja-JP') + '件）',
    item.price.toLocaleString('ja-JP') + '円〜（税込・投稿時点）'
  ];
  if (sizes) lines.push(sizes);
  lines.push('', '楽天で詳細を見る', item.affiliateUrl, '', genre.tags + ' #楽天で見つけた');
  return lines.join('\n').slice(0, 500);
}

/** 投稿せずに、選ばれる商品と投稿文を確認する */
function previewDaily() {
  const genre = todayGenre_();
  const item = pickItem_(genre);
  Logger.log('ジャンル：' + genre.label + '\n商品：' + item.name + '\n画像：' + item.images[0] +
    '\n\n--- 投稿文 ---\n' + buildPostText_(item, genre));
}

/** 毎日の投稿本体 */
function postDaily() {
  const genre = todayGenre_();
  const item = pickItem_(genre);
  const text = buildPostText_(item, genre);
  const postId = postToThreads(text, item.images[0]);
  rememberPosted_(item.code);
  Logger.log('Threadsに投稿しました：' + postId + '\n' + item.name);
}

/** 毎日20時台に postDaily を実行するトリガーを作る（一度だけ実行） */
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'postDaily'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('postDaily').timeBased().everyDays(1).atHour(20).inTimezone('Asia/Tokyo').create();
  Logger.log('毎日20時台に自動投稿するトリガーを作りました');
}
