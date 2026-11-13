/**
 * Room Totonoe — 投稿の数字を記録する
 *
 * collectInsights（毎晩23時台）が、直近7日の投稿の閲覧数・いいね・返信・再投稿・シェアと、
 * アカウント全体のフォロワー数・リンクのクリック数（URLごと）を
 * queue/insights/日付.json に保存する。
 * 毎朝のClaudeはこのファイルを読んで、伸びた型・クリックされた商品を次の投稿に生かす。
 *
 * 必要な権限：threads_manage_insights（Threads.gs の THREADS_SCOPES に追加済み。
 * 追加後に threadsStep1 → threadsStep2 をやり直してトークンを取り直す）
 */

const INSIGHT_DAYS = 7;
const MEDIA_METRICS = 'views,likes,replies,reposts,quotes,shares';

function dateKeyDaysAgo_(n) {
  return Utilities.formatDate(new Date(Date.now() - n * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
}

function metricValues_(json) {
  const out = {};
  (json.data || []).forEach(function (m) {
    if (m.total_value) out[m.name] = m.total_value.value;
    else if (m.values && m.values.length) out[m.name] = m.values[m.values.length - 1].value;
  });
  return out;
}

function mediaInsights_(mediaId, token) {
  return metricValues_(fetchJson_(THREADS_GRAPH + '/v1.0/' + mediaId + '/insights?' +
    query_({ metric: MEDIA_METRICS, access_token: token })));
}

/** 毎晩：直近7日の投稿の数字を保存する */
function collectInsights() {
  const token = requireProp_('THREADS_TOKEN');
  const userId = requireProp_('THREADS_USER_ID');
  const result = { date: todayKey_(), collectedAt: new Date().toISOString(), posts: [], account: {}, errors: [] };

  for (let d = 0; d < INSIGHT_DAYS; d++) {
    const key = dateKeyDaysAgo_(d);
    ['-morning', '-tip', ''].forEach(function (suffix) {
      let rec;
      try {
        const f = ghGetFile('queue/posted/' + key + suffix + '.json');
        if (!f) return;
        rec = JSON.parse(f.text);
      } catch (e) {
        result.errors.push(key + suffix + '：記録を読めませんでした');
        return;
      }
      if (!rec.threadsId) return;
      const row = {
        date: key,
        kind: rec.kind || (suffix === '-tip' ? 'tips' : suffix === '-morning' ? 'morning' : 'product'),
        threadsId: rec.threadsId,
        format: rec.format || '',
        hook: rec.hook || '',
        topic: rec.topic || '',
        theme: rec.theme || '',
        codes: rec.codes || (rec.code ? [rec.code] : []),
        firstLine: String(rec.text || '').replace(/^【PR】\n?/, '').split('\n')[0].slice(0, 60)
      };
      try {
        Object.assign(row, mediaInsights_(rec.threadsId, token));
      } catch (e) {
        result.errors.push(key + suffix + '：' + e.message);
      }
      result.posts.push(row);
    });
  }

  // アカウント全体：フォロワー数と、直近7日のリンクのクリック数（URLごと）
  try {
    result.account.followers = metricValues_(fetchJson_(THREADS_GRAPH + '/v1.0/' + userId + '/threads_insights?' +
      query_({ metric: 'followers_count', access_token: token }))).followers_count;
  } catch (e) {
    result.errors.push('followers_count：' + e.message);
  }
  try {
    const until = Math.floor(Date.now() / 1000);
    const json = fetchJson_(THREADS_GRAPH + '/v1.0/' + userId + '/threads_insights?' +
      query_({ metric: 'clicks,views', since: until - INSIGHT_DAYS * 86400, until: until, access_token: token }));
    (json.data || []).forEach(function (m) {
      if (m.name === 'clicks') result.account.linkClicks = m.link_total_values || m.total_value || m.values || null;
      if (m.name === 'views') result.account.views = m.total_value ? m.total_value.value : (m.values || null);
    });
  } catch (e) {
    result.errors.push('clicks：' + e.message);
  }

  if (result.errors.some(function (m) { return /permission|scope|権限|OAuth/i.test(m); })) {
    Logger.log('インサイトの権限がないようです。threadsStep1 → threadsStep2 をやり直してください');
  }
  ghPutFile('queue/insights/' + result.date + '.json', JSON.stringify(result, null, 2), 'Record insights for ' + result.date);
  Logger.log('数字を保存しました：投稿' + result.posts.length + '件' + (result.errors.length ? '（エラー' + result.errors.length + '件）' : ''));
}
