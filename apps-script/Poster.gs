/**
 * Room Totonoe — 毎日の自動投稿
 *
 * collectCandidates … 朝、楽天の売れ筋から候補を3つ選んでGitHubに保存する
 * postDaily     … 夜、Claudeが書いた投稿文でThreadsに画像付きで投稿する（なければ従来の文面）
 * postTipDaily  … 昼、Claudeが書いた「暮らしのコツ」をリンクなしで投稿する（なければ投稿しない）
 * previewDaily / previewTip … 投稿はせず、今日投稿される内容をログで確認する
 * setupCollectTrigger / setupDailyTrigger … 毎朝7時台・毎晩20時台のトリガーを作る（一度だけ）
 */

// 商品を選ぶ条件
const PICK_RULES = {
  minReviewCount: 30,
  minReviewAverage: 4.0,
  minPrice: 2000,
  maxPrice: 50000
};

// 曜日ごとの担当（日〜土）。おしゃれな家具・照明を日替わりで
const GENRE_SCHEDULE = ['sideTable', 'floorLight', 'stool', 'shelf', 'lowTable', 'pendant', 'mirror'];

// 体への効果をうたう表現は使わない（薬機法対策）。商品名にあれば削る
const NG_WORDS = ['肩こり', '腰痛', '改善', '治る', '効く', '解消', '安眠', '快眠', '痩せ', 'ダイエット', '美肌', '医療', '治療'];

/** 日本時間の今日（YYYY-MM-DD） */
function todayKey_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

function todayGenreKey_() {
  // 'u' は 1=月 … 7=日。GENRE_SCHEDULE は 0=日 … 6=土
  const u = Number(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'u'));
  return GENRE_SCHEDULE[u % 7];
}

function todayGenre_() {
  return GENRES[todayGenreKey_()];
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

/** 条件に合う未投稿の商品を n 個選ぶ（上位に偏らないようランダムに） */
function pickItems_(genre, n) {
  const posted = postedCodes_();
  const collect = function (genreId) {
    let pool = [];
    for (let page = 1; page <= 3 && pool.length < n * 4; page++) {
      let items;
      try {
        items = searchRakutenItems({
          genreId: genreId,
          keyword: genre.keyword,
          sort: '-reviewCount',
          hits: 30,
          page: page,
          minPrice: PICK_RULES.minPrice,
          maxPrice: PICK_RULES.maxPrice
        });
      } catch (e) {
        if (page === 1) throw e;
        break; // 2ページ目以降が無いときはそこまで
      }
      pool = pool.concat(items.filter(function (it) {
        return it.images.length > 0 &&
          it.reviewCount >= PICK_RULES.minReviewCount &&
          it.reviewAverage >= PICK_RULES.minReviewAverage &&
          posted.indexOf(it.code) < 0;
      }));
    }
    return pool;
  };
  let pool = collect(genre.id);
  // キーワード検索でジャンル内に足りないとき（照明が別ジャンルなど）は、ジャンルを外して探し直す
  if (pool.length < n && genre.keyword) {
    const seen = pool.map(function (it) { return it.code; });
    pool = pool.concat(collect(undefined).filter(function (it) { return seen.indexOf(it.code) < 0; }));
  }
  if (!pool.length) throw new Error('条件に合う未投稿の商品が見つかりませんでした（' + genre.label + '）');
  const picked = [];
  while (pool.length && picked.length < n) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return picked;
}

function pickItem_(genre) {
  return pickItems_(genre, 1)[0];
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

// ---------------------------------------------------------------
// Claude が書いた投稿文を使う仕組み
//  朝7時台 collectCandidates：候補3つを queue/candidates/日付.json に保存
//  朝（Claudeの定期実行）：1つ選んで queue/posts/日付.json に投稿文を保存
//  夜20時台 postDaily：投稿文があればそれで投稿、なければ従来の文面で投稿
// ---------------------------------------------------------------

const THREADS_MAX = 500;
// Claudeの本文に含まれていたら使わない表現（体への効果・誇張・使用体験の捏造）
const BODY_NG = NG_WORDS.concat(['最強', '絶対', '神アイテム', '間違いない', '使ってみ', '我が家', '買ってよかった',
  '疲れ', '健康', 'http', '#PR']);

function hasGitHub_() {
  return !!props_().getProperty('GITHUB_TOKEN');
}

function candidateFromItem_(item) {
  return {
    code: item.code,
    name: item.name,
    catchcopy: item.catchcopy,
    caption: item.caption,
    price: item.price,
    reviewAverage: item.reviewAverage,
    reviewCount: item.reviewCount,
    shop: item.shop,
    sizes: sizeLine_(item.name).replace('選べるサイズ：', ''),
    affiliateUrl: item.affiliateUrl,
    image: item.images[0]
  };
}

/** 朝：候補商品を3つ選んで GitHub に保存する */
function collectCandidates() {
  const key = todayGenreKey_();
  const genre = GENRES[key];
  const items = pickItems_(genre, 3).map(candidateFromItem_);
  const data = { date: todayKey_(), genre: { key: key, label: genre.label }, items: items };
  ghPutFile('queue/candidates/' + data.date + '.json', JSON.stringify(data, null, 2),
    'Add candidates for ' + data.date);
  Logger.log('候補を保存しました：' + data.date + '\n' + items.map(function (it) { return '・' + it.name.slice(0, 40); }).join('\n'));
}

/** アフィリエイトリンクを短くする（商品ページの指定だけを残す） */
function shortAffiliateUrl_(url) {
  const m = String(url).match(/^(https:\/\/hb\.afl\.rakuten\.co\.jp\/hgc\/[^/?]+\/)\?(?:.*&)?pc=([^&]+)/);
  return m ? m[1] + '?pc=' + m[2] : url;
}

/** Claude の本文から投稿文を組み立てる。条件を満たさなければ null */
function composeFromQueue_(post, cand) {
  const body = String(post.body || '').trim();
  if (body.length < 40) return null;
  const bad = BODY_NG.filter(function (w) { return body.indexOf(w) >= 0; });
  if (bad.length) {
    Logger.log('本文に使えない表現があったため、従来の文面で投稿します：' + bad.join('、'));
    return null;
  }
  const tags = (post.hashtags || []).filter(function (t) { return /^#\S+$/.test(t); }).slice(0, 3).join(' ');
  const info = '★' + Number(cand.reviewAverage).toFixed(2) + '（レビュー' + Number(cand.reviewCount).toLocaleString('ja-JP') +
    '件）・' + Number(cand.price).toLocaleString('ja-JP') + '円〜（投稿時点）';

  const build = function (url) {
    return ['#PR', body, '', info, '▶ 楽天で見る', url, '', tags].join('\n').trim();
  };
  let text = build(cand.affiliateUrl);
  if (text.length > THREADS_MAX) text = build(shortAffiliateUrl_(cand.affiliateUrl));
  if (text.length > THREADS_MAX) {
    Logger.log('投稿文が' + THREADS_MAX + '文字を超えるため、従来の文面で投稿します');
    return null;
  }
  return text;
}

/** 今日の投稿内容を決める。{ text, image, code, source } */
function todaysPost_() {
  const date = todayKey_();
  const genre = todayGenre_();
  if (hasGitHub_()) {
    try {
      const postFile = ghGetFile('queue/posts/' + date + '.json');
      const candFile = ghGetFile('queue/candidates/' + date + '.json');
      if (postFile && candFile) {
        const post = JSON.parse(postFile.text);
        const cand = (JSON.parse(candFile.text).items || []).filter(function (c) { return c.code === post.code; })[0];
        const text = cand ? composeFromQueue_(post, cand) : null;
        if (text) return { text: text, image: cand.image, code: cand.code, source: 'claude' };
      } else {
        Logger.log('今日のClaudeの投稿文が見つからないため、従来の文面で投稿します');
      }
    } catch (e) {
      Logger.log('Claudeの投稿文を読めなかったため、従来の文面で投稿します：' + e.message);
    }
  }
  const item = pickItem_(genre);
  return { text: buildPostText_(item, genre), image: item.images[0], code: item.code, source: 'template' };
}

/** 投稿せずに、今日投稿される内容を確認する */
function previewDaily() {
  const p = todaysPost_();
  Logger.log('文面の種類：' + (p.source === 'claude' ? 'Claudeが書いた文章' : '従来の文面') +
    '\n画像：' + p.image + '\n文字数：' + p.text.length + '\n\n--- 投稿文 ---\n' + p.text);
}

/** 毎日の投稿本体 */
function postDaily() {
  const p = todaysPost_();
  const postId = postToThreads(p.text, p.image);
  rememberPosted_(p.code);
  Logger.log('Threadsに投稿しました（' + p.source + '）：' + postId);
  if (hasGitHub_()) {
    try {
      ghPutFile('queue/posted/' + todayKey_() + '.json',
        JSON.stringify({ date: todayKey_(), code: p.code, source: p.source, threadsId: postId, text: p.text }, null, 2),
        'Record post for ' + todayKey_());
    } catch (e) {
      Logger.log('投稿記録の保存に失敗しました（投稿自体は完了）：' + e.message);
    }
  }
}

// ---------------------------------------------------------------
// お役立ち投稿（毎日12時台・リンクなし）
//  Claudeが queue/tips/日付.json に書いた文章をテキストのみで投稿する。
//  文章がない日は何も投稿しない（決まった文面の宣伝は増やさない）。
// ---------------------------------------------------------------

function todaysTip_() {
  if (!hasGitHub_()) return null;
  const file = ghGetFile('queue/tips/' + todayKey_() + '.json');
  if (!file) return null;
  const tip = JSON.parse(file.text);
  const body = String(tip.body || '').trim();
  if (body.length < 60) return null;
  const bad = BODY_NG.filter(function (w) { return body.indexOf(w) >= 0; });
  if (bad.length) {
    Logger.log('お役立ち投稿に使えない表現があったため、今日は投稿しません：' + bad.join('、'));
    return null;
  }
  const tags = (tip.hashtags || []).filter(function (t) { return /^#\S+$/.test(t); }).slice(0, 3).join(' ');
  const text = (body + (tags ? '\n\n' + tags : '')).slice(0, THREADS_MAX);
  return { text: text, theme: tip.theme || '' };
}

/** お役立ち投稿の内容を確認する（投稿はしない） */
function previewTip() {
  const tip = todaysTip_();
  Logger.log(tip ? 'テーマ：' + tip.theme + '\n文字数：' + tip.text.length + '\n\n' + tip.text
    : '今日のお役立ち投稿はまだありません');
}

/** お役立ち投稿の本体 */
function postTipDaily() {
  const tip = todaysTip_();
  if (!tip) {
    Logger.log('今日のお役立ち投稿がないため、何もしませんでした');
    return;
  }
  const postId = postToThreads(tip.text);
  Logger.log('お役立ち投稿をしました：' + postId);
  try {
    ghPutFile('queue/posted/' + todayKey_() + '-tip.json',
      JSON.stringify({ date: todayKey_(), theme: tip.theme, threadsId: postId, text: tip.text }, null, 2),
      'Record tip post for ' + todayKey_());
  } catch (e) {
    Logger.log('投稿記録の保存に失敗しました（投稿自体は完了）：' + e.message);
  }
}

/** 毎日12時台に postTipDaily を実行するトリガーを作る（一度だけ実行） */
function setupTipTrigger() {
  replaceTrigger_('postTipDaily', 12);
  Logger.log('毎日12時台にお役立ち投稿をするトリガーを作りました');
}

/** 毎日20時台に postDaily を実行するトリガーを作る（一度だけ実行） */
function setupDailyTrigger() {
  replaceTrigger_('postDaily', 20);
  Logger.log('毎日20時台に自動投稿するトリガーを作りました');
}

/** 毎朝7時台に collectCandidates を実行するトリガーを作る（一度だけ実行） */
function setupCollectTrigger() {
  replaceTrigger_('collectCandidates', 7);
  Logger.log('毎朝7時台に候補を保存するトリガーを作りました');
}

function replaceTrigger_(fn, hour) {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === fn; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger(fn).timeBased().everyDays(1).atHour(hour).inTimezone('Asia/Tokyo').create();
}
