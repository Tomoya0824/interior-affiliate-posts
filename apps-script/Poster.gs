/**
 * Room Totonoe — 毎日の自動投稿
 *
 * collectCandidates … 朝7時台、楽天から今日のジャンルの候補を3つ選んでGitHubに保存する
 * postMorningDaily  … 朝9時台、Claudeが書いた「問いかけ」をテキストで投稿する（なければ投稿しない）
 * postTipDaily      … 昼12時台、Claudeが書いた「部屋づくりのコツ」をリンクなしで投稿する（なければ投稿しない）
 * postDaily         … 夜20時台、Claudeが書いた商品投稿を、画像（3枚ならカルーセル）付きで投稿し、
 *                     楽天のリンクは自分の投稿へのリプ欄に置く（なければ従来の文面）
 * collectInsights   … 夜23時台、直近7日の投稿の閲覧数・返信数とリンクのクリック数をGitHubに保存する
 * previewDaily / previewTip / previewMorning … 投稿はせず、今日投稿される内容をログで確認する
 * setupAllTriggers  … 上のトリガーをまとめて作り直す（一度だけ）
 */

// 商品を選ぶ条件（ジャンルごとに minPrice / maxPrice で上書きできる）
// フォロワーが少ないうちは、迷わず買える価格帯（〜1.5万円）のほうがクリックから購入につながりやすい
const PICK_RULES = {
  minReviewCount: 30,
  minReviewAverage: 4.0,
  minPrice: 1500,
  maxPrice: 15000
};

// 曜日ごとの担当（日〜土）。家具より、置くだけで部屋が変わる照明・雑貨を多めに
const GENRE_SCHEDULE = ['tableLamp', 'vase', 'sideTable', 'cushionCover', 'shelf', 'floorLight', 'wallDecor'];

// 季節の差し替え（MM-DD の範囲・曜日番号 0=日 … 6=土）
const SEASONAL_OVERRIDES = [
  { from: '11-01', to: '12-20', days: { 3: 'winterRug', 6: 'xmas' } }
];

// 体への効果をうたう表現は使わない（薬機法対策）。商品名にあれば削る
const NG_WORDS = ['肩こり', '腰痛', '改善', '治る', '効く', '解消', '安眠', '快眠', '痩せ', 'ダイエット', '美肌', '医療', '治療'];

/** 日本時間の今日（YYYY-MM-DD） */
function todayKey_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

function todayGenreKey_() {
  // 'u' は 1=月 … 7=日。GENRE_SCHEDULE は 0=日 … 6=土
  const dow = Number(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'u')) % 7;
  const md = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MM-dd');
  for (let i = 0; i < SEASONAL_OVERRIDES.length; i++) {
    const o = SEASONAL_OVERRIDES[i];
    if (md >= o.from && md <= o.to && o.days[dow] && GENRES[o.days[dow]]) return o.days[dow];
  }
  return GENRE_SCHEDULE[dow];
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
          minPrice: genre.minPrice || PICK_RULES.minPrice,
          maxPrice: genre.maxPrice || PICK_RULES.maxPrice
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
    '【PR】' + shortName_(item.name),
    '',
    '★' + item.reviewAverage.toFixed(2) + '（レビュー' + item.reviewCount.toLocaleString('ja-JP') + '件）',
    item.price.toLocaleString('ja-JP') + '円〜（税込・投稿時点）'
  ];
  if (sizes) lines.push(sizes);
  lines.push('', '楽天市場で見る ▶', shortAffiliateUrl_(item.affiliateUrl));
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
    image: item.images[0],
    images: item.images.slice(0, 3)
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

// ---------------------------------------------------------------
// 商品投稿（2026-11-13 改訂）
//  本文（画像・カルーセル付き）にはリンクを入れず、楽天のリンクは自分の投稿へのリプ欄に置く。
//  ・楽天アフィリエイトのガイドラインで禁止されているのは「他人の投稿」へのリンク掲載。自分の投稿へのリプライは可
//  ・広告であることは本文とリプの両方の先頭に【PR】で示す（ステマ規制対応）
//  ・ハッシュタグは本文に並べず、トピックタグを1つだけ API の topic_tag で付ける
//    （本文の最初の「#〇〇」がトピックとして扱われるため、従来は「#PR」がトピックになっていた）
// ---------------------------------------------------------------

const PR_LABEL = '【PR】';
const NUMS = ['①', '②', '③', '④', '⑤'];

/** queue/posts の形（新旧どちらも）を読みやすい形にそろえる */
function normalizePost_(post) {
  let items = (post.items || []).filter(function (it) { return it && it.code; });
  if (!items.length && post.code) items = [{ code: post.code, label: '' }];
  const topic = post.topic || ((post.hashtags || [])[0] || '').replace(/^#/, '') || 'インテリア';
  return {
    format: items.length >= 2 ? 'pick' : 'single',
    hook: post.hook || '',
    body: String(post.body || '').trim(),
    topic: topic,
    items: items
  };
}

function checkBody_(body, minLen) {
  if (body.length < minLen) return '本文が短すぎます（' + body.length + '文字）';
  const bad = BODY_NG.filter(function (w) { return body.indexOf(w) >= 0; });
  if (bad.length) return '本文に使えない表現があります：' + bad.join('、');
  if (/#\S/.test(body)) return '本文にハッシュタグがあります（トピックは topic で指定）';
  return '';
}

/** リプ欄に置く、1商品ぶんのリンク文 */
function linkReplyText_(cand, label, num) {
  const info = '★' + Number(cand.reviewAverage).toFixed(2) + '（レビュー' + Number(cand.reviewCount).toLocaleString('ja-JP') +
    '件）・' + Number(cand.price).toLocaleString('ja-JP') + '円〜（投稿時点）';
  const head = PR_LABEL + (num || '') + (label || shortName_(cand.name));
  const build = function (url) { return [head, info, '楽天市場で見る ▶', url].join('\n'); };
  let text = build(cand.affiliateUrl);
  if (text.length > THREADS_MAX) text = build(shortAffiliateUrl_(cand.affiliateUrl));
  return text;
}

/**
 * 今日の商品投稿を組み立てる。
 * { main: { text, images, topicTag }, replies: [text...], codes: [...], format, hook, source }
 */
function todaysPost_() {
  const date = todayKey_();
  const genre = todayGenre_();
  if (hasGitHub_()) {
    try {
      const postFile = ghGetFile('queue/posts/' + date + '.json');
      const candFile = ghGetFile('queue/candidates/' + date + '.json');
      if (postFile && candFile) {
        const post = normalizePost_(JSON.parse(postFile.text));
        const cands = JSON.parse(candFile.text).items || [];
        const picked = post.items.map(function (it) {
          return { cand: cands.filter(function (c) { return c.code === it.code; })[0], label: it.label };
        }).filter(function (p) { return !!p.cand; });
        const problem = picked.length !== post.items.length ? '候補にない商品コードがあります' : checkBody_(post.body, 40);
        if (!problem) {
          const multi = picked.length >= 2;
          const mainText = PR_LABEL + '\n' + post.body + '\n\n楽天市場のリンクはリプ欄に置いています';
          if (mainText.length <= THREADS_MAX) {
            const images = multi
              ? picked.map(function (p) { return p.cand.image; })
              : (picked[0].cand.images && picked[0].cand.images.length ? picked[0].cand.images : [picked[0].cand.image]);
            return {
              main: { text: mainText, images: images, topicTag: post.topic },
              replies: picked.map(function (p, n) { return linkReplyText_(p.cand, p.label, multi ? NUMS[n] : ''); }),
              codes: picked.map(function (p) { return p.cand.code; }),
              format: post.format, hook: post.hook, topic: post.topic, source: 'claude'
            };
          }
          Logger.log('本文が長すぎるため、従来の文面で投稿します');
        } else {
          Logger.log(problem + '。従来の文面で投稿します');
        }
      } else {
        Logger.log('今日のClaudeの投稿文が見つからないため、従来の文面で投稿します');
      }
    } catch (e) {
      Logger.log('Claudeの投稿文を読めなかったため、従来の文面で投稿します：' + e.message);
    }
  }
  const item = pickItem_(genre);
  return {
    main: { text: buildPostText_(item, genre), images: [item.images[0]], topicTag: 'インテリア' },
    replies: [], codes: [item.code], format: 'template', hook: '', topic: 'インテリア', source: 'template'
  };
}

/** 投稿せずに、今日投稿される内容を確認する */
function previewDaily() {
  const p = todaysPost_();
  Logger.log('文面の種類：' + (p.source === 'claude' ? 'Claudeが書いた文章（' + p.format + '）' : '従来の文面') +
    '\nトピック：' + p.main.topicTag + '\n画像：\n' + p.main.images.join('\n') +
    '\n\n--- 本文（' + p.main.text.length + '文字）---\n' + p.main.text +
    p.replies.map(function (r, n) { return '\n\n--- リプ' + (n + 1) + '（' + r.length + '文字）---\n' + r; }).join(''));
}

/** 毎日の商品投稿 */
function postDaily() {
  const p = todaysPost_();
  const postId = publishThreads(p.main);
  p.codes.forEach(rememberPosted_);
  Logger.log('Threadsに投稿しました（' + p.source + '）：' + postId);

  // リンクを自分の投稿へのリプ欄に、順につなげて置く
  const replyIds = [];
  let replyError = '';
  let parent = postId;
  for (let i = 0; i < p.replies.length; i++) {
    try {
      parent = publishThreads({ text: p.replies[i], replyToId: parent });
      replyIds.push(parent);
    } catch (e) {
      replyError = e.message;
      break;
    }
  }
  if (replyError) {
    // 返信の権限がないなどで失敗したら、リンクが消えないよう、リンクだけの投稿を別に出す
    Logger.log('リプ欄へのリンク投稿に失敗しました（' + replyError + '）。リンクを別の投稿で出します。' +
      'threadsStep1 → threadsStep2 をやり直して、返信の権限付きのトークンを取り直してください');
    try {
      publishThreads({ text: p.replies[replyIds.length] });
    } catch (e2) {
      Logger.log('リンク投稿にも失敗しました：' + e2.message);
    }
  }

  if (hasGitHub_()) {
    try {
      ghPutFile('queue/posted/' + todayKey_() + '.json', JSON.stringify({
        date: todayKey_(), kind: 'product', codes: p.codes, code: p.codes[0], source: p.source, format: p.format,
        hook: p.hook, topic: p.topic, threadsId: postId, replyIds: replyIds, replyError: replyError,
        text: p.main.text, replies: p.replies
      }, null, 2), 'Record post for ' + todayKey_());
    } catch (e) {
      Logger.log('投稿記録の保存に失敗しました（投稿自体は完了）：' + e.message);
    }
  }
}

// ---------------------------------------------------------------
// テキストだけの投稿（朝の問いかけ・昼のコツ）
//  Claudeが queue/<dir>/日付.json に書いた文章を、リンクなしで投稿する。
//  文章がない日は何も投稿しない（決まった文面の宣伝は増やさない）。
// ---------------------------------------------------------------

function todaysText_(dir) {
  if (!hasGitHub_()) return null;
  const file = ghGetFile('queue/' + dir + '/' + todayKey_() + '.json');
  if (!file) return null;
  const data = JSON.parse(file.text);
  const body = String(data.body || '').trim();
  const problem = checkBody_(body, dir === 'morning' ? 20 : 60);
  if (problem) {
    Logger.log(dir + '：' + problem + '。今日は投稿しません');
    return null;
  }
  const topic = data.topic || ((data.hashtags || [])[0] || '').replace(/^#/, '') || 'インテリア';
  return { text: body.slice(0, THREADS_MAX), topic: topic, theme: data.theme || '', hook: data.hook || '' };
}

function previewText_(dir) {
  const t = todaysText_(dir);
  Logger.log(t ? 'テーマ：' + t.theme + '\nトピック：' + t.topic + '\n文字数：' + t.text.length + '\n\n' + t.text
    : '今日の ' + dir + ' の投稿はまだありません');
}

function postText_(dir, suffix) {
  const t = todaysText_(dir);
  if (!t) {
    Logger.log('今日の ' + dir + ' の投稿がないため、何もしませんでした');
    return;
  }
  const postId = publishThreads({ text: t.text, topicTag: t.topic });
  Logger.log(dir + ' を投稿しました：' + postId);
  try {
    ghPutFile('queue/posted/' + todayKey_() + suffix + '.json',
      JSON.stringify({ date: todayKey_(), kind: dir, theme: t.theme, hook: t.hook, topic: t.topic, threadsId: postId, text: t.text }, null, 2),
      'Record ' + dir + ' post for ' + todayKey_());
  } catch (e) {
    Logger.log('投稿記録の保存に失敗しました（投稿自体は完了）：' + e.message);
  }
}

function previewTip() { previewText_('tips'); }
function postTipDaily() { postText_('tips', '-tip'); }
function previewMorning() { previewText_('morning'); }
function postMorningDaily() { postText_('morning', '-morning'); }

// ---------------------------------------------------------------
// トリガー
// ---------------------------------------------------------------

/** すべてのトリガーをまとめて作り直す（一度だけ実行） */
function setupAllTriggers() {
  replaceTrigger_('collectCandidates', 7);
  replaceTrigger_('postMorningDaily', 9);
  replaceTrigger_('postTipDaily', 12);
  replaceTrigger_('postDaily', 20);
  replaceTrigger_('collectInsights', 23);
  Logger.log('トリガーを作りました：7時台 候補 / 9時台 朝の問いかけ / 12時台 コツ / 20時台 商品 / 23時台 数字の記録');
}

function setupTipTrigger() { replaceTrigger_('postTipDaily', 12); }
function setupDailyTrigger() { replaceTrigger_('postDaily', 20); }
function setupCollectTrigger() { replaceTrigger_('collectCandidates', 7); }

function replaceTrigger_(fn, hour) {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === fn; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger(fn).timeBased().everyDays(1).atHour(hour).inTimezone('Asia/Tokyo').create();
}
