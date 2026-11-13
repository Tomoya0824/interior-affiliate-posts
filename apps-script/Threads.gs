/**
 * Room Totonoe — Threads 連携
 *
 * 使い方（初回だけ）
 *  1. スクリプト プロパティに THREADS_APP_ID と THREADS_APP_SECRET を入れる
 *  2. threadsStep1_showAuthUrl を実行し、ログに出たURLをブラウザで開いて「許可」
 *  3. callback.html に表示されたコードを、スクリプト プロパティ THREADS_AUTH_CODE に貼る
 *  4. threadsStep2_exchangeCode を実行（60日有効のトークンが保存される）
 *  5. threadsStep3_testPost を実行して、テキストのテスト投稿を確認
 *  6. setupThreadsRefreshTrigger を一度実行（毎週トークンを自動更新）
 *
 * キーやトークンはスクリプト プロパティにだけ保存し、コードには書かない。
 */

const THREADS_REDIRECT_URI = 'https://tomoya0824.github.io/interior-affiliate-posts/callback.html';
const THREADS_AUTH_BASE = 'https://threads.com/oauth/authorize';
const THREADS_GRAPH = 'https://graph.threads.com';
// 返信（リンクをリプ欄に置く）とインサイト（閲覧数・クリック数の記録）にも使う。
// スコープを足したら threadsStep1 → threadsStep2 をやり直して、トークンを取り直す
const THREADS_SCOPES = ['threads_basic', 'threads_content_publish', 'threads_manage_replies', 'threads_manage_insights'];

function props_() {
  return PropertiesService.getScriptProperties();
}

function requireProp_(name) {
  const value = props_().getProperty(name);
  if (!value) throw new Error('スクリプト プロパティ「' + name + '」が未設定です');
  return value.trim();
}

function fetchJson_(url, options) {
  const res = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true }, options || {}));
  const code = res.getResponseCode();
  const body = res.getContentText();
  let json;
  try { json = JSON.parse(body); } catch (e) { json = { raw: body }; }
  if (code >= 400 || json.error) {
    const msg = json.error ? (json.error.message || JSON.stringify(json.error)) : body;
    throw new Error('APIエラー (' + code + '): ' + msg);
  }
  return json;
}

function query_(params) {
  return Object.keys(params)
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');
}

/** 手順2：認可用URLをログに表示する */
function threadsStep1_showAuthUrl() {
  const url = THREADS_AUTH_BASE + '?' + query_({
    client_id: requireProp_('THREADS_APP_ID'),
    redirect_uri: THREADS_REDIRECT_URI,
    scope: THREADS_SCOPES.join(','),
    response_type: 'code',
    state: 'threads'
  });
  Logger.log('このURLをブラウザで開いて「許可」を押してください:\n' + url);
}

/** 手順4：認可コードを長期トークン（60日）に交換して保存する */
function threadsStep2_exchangeCode() {
  const code = requireProp_('THREADS_AUTH_CODE').replace(/#_$/, '');

  const shortLived = fetchJson_(THREADS_GRAPH + '/oauth/access_token', {
    method: 'post',
    payload: {
      client_id: requireProp_('THREADS_APP_ID'),
      client_secret: requireProp_('THREADS_APP_SECRET'),
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: THREADS_REDIRECT_URI
    }
  });

  const longLived = fetchJson_(THREADS_GRAPH + '/access_token?' + query_({
    grant_type: 'th_exchange_token',
    client_secret: requireProp_('THREADS_APP_SECRET'),
    access_token: shortLived.access_token
  }));

  saveThreadsToken_(longLived);
  props_().setProperty('THREADS_USER_ID', String(shortLived.user_id));
  props_().deleteProperty('THREADS_AUTH_CODE');
  Logger.log('トークンを保存しました。有効期限: ' + props_().getProperty('THREADS_TOKEN_EXPIRES'));
}

function saveThreadsToken_(json) {
  const expires = new Date(Date.now() + Number(json.expires_in || 0) * 1000);
  props_().setProperties({
    THREADS_TOKEN: json.access_token,
    THREADS_TOKEN_EXPIRES: expires.toISOString()
  });
}

/** 長期トークンを更新する（期限前ならいつでも可） */
function refreshThreadsToken() {
  const json = fetchJson_(THREADS_GRAPH + '/refresh_access_token?' + query_({
    grant_type: 'th_refresh_token',
    access_token: requireProp_('THREADS_TOKEN')
  }));
  saveThreadsToken_(json);
  Logger.log('トークンを更新しました。有効期限: ' + props_().getProperty('THREADS_TOKEN_EXPIRES'));
}

/** 毎週月曜にトークンを自動更新するトリガーを作る（一度だけ実行） */
function setupThreadsRefreshTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'refreshThreadsToken'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('refreshThreadsToken').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(4).create();
  Logger.log('毎週月曜4時にトークンを更新するトリガーを作りました');
}

/**
 * Threads に投稿する（従来の呼び方）。
 * imageUrl を渡すと画像付き、省略するとテキストのみ。戻り値は公開された投稿のID。
 */
function postToThreads(text, imageUrl) {
  return publishThreads({ text: text, images: imageUrl ? [imageUrl] : [] });
}

/**
 * Threads に投稿する。
 * opts: { text, images: [url,...]（0枚=テキスト、1枚=画像、2〜20枚=カルーセル）, topicTag, replyToId }
 * 戻り値は公開された投稿のID。
 */
function publishThreads(opts) {
  const userId = requireProp_('THREADS_USER_ID');
  const token = requireProp_('THREADS_TOKEN');
  const images = (opts.images || []).filter(function (u) { return !!u; }).slice(0, 20);
  const endpoint = THREADS_GRAPH + '/v1.0/' + userId + '/threads';

  const payload = { text: opts.text || '', access_token: token };
  if (opts.topicTag) payload.topic_tag = cleanTopicTag_(opts.topicTag);
  if (opts.replyToId) payload.reply_to_id = opts.replyToId;

  if (images.length >= 2) {
    // カルーセル：画像ごとに子コンテナを作ってから、まとめる
    const children = images.map(function (url) {
      return fetchJson_(endpoint, {
        method: 'post',
        payload: { media_type: 'IMAGE', image_url: url, is_carousel_item: 'true', access_token: token }
      }).id;
    });
    children.forEach(function (id) { waitContainerReady_(id, token); });
    payload.media_type = 'CAROUSEL';
    payload.children = children.join(',');
  } else if (images.length === 1) {
    payload.media_type = 'IMAGE';
    payload.image_url = images[0];
  } else {
    payload.media_type = 'TEXT';
  }

  const container = fetchJson_(endpoint, { method: 'post', payload: payload });
  waitContainerReady_(container.id, token);

  const published = fetchJson_(THREADS_GRAPH + '/v1.0/' + userId + '/threads_publish', {
    method: 'post',
    payload: { creation_id: container.id, access_token: token }
  });
  return published.id;
}

/** コンテナの準備ができるまで待つ（最大およそ90秒） */
function waitContainerReady_(containerId, token) {
  for (let i = 0; i < 18; i++) {
    Utilities.sleep(i === 0 ? 3000 : 5000);
    let st;
    try {
      st = fetchJson_(THREADS_GRAPH + '/v1.0/' + containerId + '?' + query_({ fields: 'status,error_message', access_token: token }));
    } catch (e) {
      continue; // 状態が読めないときは待ち続ける
    }
    if (st.status === 'FINISHED' || st.status === 'PUBLISHED') return;
    if (st.status === 'ERROR' || st.status === 'EXPIRED') {
      throw new Error('Threadsのメディア処理に失敗しました：' + (st.error_message || st.status));
    }
  }
  // 状態が FINISHED にならなくても、公開を試す（失敗すればエラーになる）
}

/** トピックタグに使えない文字（# . &）を除く */
function cleanTopicTag_(tag) {
  return String(tag).replace(/^#/, '').replace(/[.&＆]/g, '').trim().slice(0, 50);
}

/** 手順5：テキストのテスト投稿（確認後、Threadsアプリから削除してください） */
function threadsStep3_testPost() {
  const id = postToThreads('テスト投稿です。連携の確認が終わったら削除します。');
  Logger.log('投稿しました。投稿ID: ' + id);
}
