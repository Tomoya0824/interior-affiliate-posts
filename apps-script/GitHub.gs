/**
 * Room Totonoe — GitHub への読み書き
 *
 * スクリプト プロパティ GITHUB_TOKEN に、このリポジトリだけに
 * Contents の読み書き権限を付けた Fine-grained トークンを入れておく。
 */

const GH_OWNER = 'Tomoya0824';
const GH_REPO = 'interior-affiliate-posts';
const GH_BRANCH = 'main';

function ghRequest_(method, path, body) {
  const url = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO + '/contents/' +
    path.split('/').map(encodeURIComponent).join('/') + (method === 'get' ? '?ref=' + GH_BRANCH : '');
  const options = {
    method: method,
    headers: {
      Authorization: 'Bearer ' + requireProp_('GITHUB_TOKEN'),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    muteHttpExceptions: true
  };
  if (body) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }
  return UrlFetchApp.fetch(url, options);
}

/** ファイルを読む。なければ null */
function ghGetFile(path) {
  const res = ghRequest_('get', path);
  if (res.getResponseCode() === 404) return null;
  if (res.getResponseCode() >= 400) {
    throw new Error('GitHubの読み込みに失敗 (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
  }
  const json = JSON.parse(res.getContentText());
  const text = Utilities.newBlob(Utilities.base64Decode(json.content.replace(/\n/g, ''))).getDataAsString('UTF-8');
  return { text: text, sha: json.sha };
}

/** ファイルを作成・上書きする */
function ghPutFile(path, text, message) {
  const existing = ghGetFile(path);
  const body = {
    message: message,
    content: Utilities.base64Encode(text, Utilities.Charset.UTF_8),
    branch: GH_BRANCH
  };
  if (existing) body.sha = existing.sha;
  const res = ghRequest_('put', path, body);
  if (res.getResponseCode() >= 400) {
    throw new Error('GitHubへの保存に失敗 (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
  }
}

/** 接続テスト：読み込みと書き込みの両方を確認する */
function githubTest() {
  const guide = ghGetFile('docs/writing-guide.md');
  if (!guide) throw new Error('docs/writing-guide.md が見つかりません');
  ghPutFile('queue/README.md',
    '# queue\n\n- candidates/：Apps Scriptが毎朝保存する候補商品\n- posts/：Claudeが書いた投稿文\n- posted/：投稿済みの記録\n',
    'Set up queue folder');
  Logger.log('GitHubに接続できました（読み込み・書き込みOK）');
}
