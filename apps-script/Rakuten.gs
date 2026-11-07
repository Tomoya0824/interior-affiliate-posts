/**
 * Room Totonoe — 楽天市場 商品検索
 *
 * スクリプト プロパティに次の3つを入れておく
 *  RAKUTEN_APP_ID        … Rakuten Developers の Application ID
 *  RAKUTEN_ACCESS_KEY    … 同じ画面の Access Key（pk_ で始まる）
 *  RAKUTEN_AFFILIATE_ID  … 同じ画面の Affiliate ID
 *
 * 2026年の新API（openapi.rakuten.co.jp）は、アプリに登録した
 * 「許可されたWebサイト」からのリクエストだけを受け付けるため、
 * GitHub Pages のURLを Referer として送る。
 */

const RAKUTEN_SITE = 'https://tomoya0824.github.io/interior-affiliate-posts/';
const RAKUTEN_ENDPOINTS = [
  'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701',
  'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601'
];

// 楽天市場のジャンルID（年間ランキングのページと同じ）
const GENRES = {
  interior: { id: 100804, label: 'インテリア・寝具・収納', tags: '#インテリア #収納 #部屋づくり' },
  kitchen: { id: 558944, label: 'キッチン用品・食器・調理器具', tags: '#キッチン #キッチン用品 #暮らしを整える' }
};

/**
 * 楽天市場で商品を検索して、扱いやすい形にそろえて返す。
 * options: { genreId, keyword, sort, hits, page, minPrice, maxPrice }
 */
function searchRakutenItems(options) {
  options = options || {};
  const params = {
    applicationId: requireProp_('RAKUTEN_APP_ID'),
    accessKey: requireProp_('RAKUTEN_ACCESS_KEY'),
    affiliateId: requireProp_('RAKUTEN_AFFILIATE_ID'),
    format: 'json',
    formatVersion: 2,
    hits: options.hits || 30,
    page: options.page || 1,
    sort: options.sort || '-reviewCount',
    imageFlag: 1,
    availability: 1
  };
  if (options.genreId) params.genreId = options.genreId;
  if (options.keyword) params.keyword = options.keyword;
  if (options.minPrice) params.minPrice = options.minPrice;
  if (options.maxPrice) params.maxPrice = options.maxPrice;

  const endpoint = props_().getProperty('RAKUTEN_ENDPOINT') || RAKUTEN_ENDPOINTS[0];
  const json = rakutenFetch_(endpoint, params, rakutenHeaderMode_());
  return (json.Items || []).map(normalizeRakutenItem_);
}

function rakutenHeaderMode_() {
  return props_().getProperty('RAKUTEN_HEADER_MODE') || 'referer';
}

function rakutenFetch_(endpoint, params, headerMode) {
  const headers = { 'User-Agent': 'RoomTotonoePoster/1.0' };
  if (headerMode === 'referer' || headerMode === 'both') headers.Referer = RAKUTEN_SITE;
  if (headerMode === 'origin' || headerMode === 'both') headers.Origin = RAKUTEN_SITE.replace(/\/[^/]*\/$/, '').replace(/\/$/, '');

  const res = UrlFetchApp.fetch(endpoint + '?' + query_(params), {
    method: 'get',
    headers: headers,
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const body = res.getContentText();
  let json;
  try { json = JSON.parse(body); } catch (e) { json = { raw: body.slice(0, 300) }; }

  // エラーは2つの形で返ることがある
  const err = json.error || (json.errors && (json.errors.errorCode || (json.errors[0] && json.errors[0].errorCode)));
  if (code >= 400 || err) {
    const detail = json.error_description || json.error ||
      (json.errors && (json.errors.errorMessage || JSON.stringify(json.errors))) || json.raw || body.slice(0, 300);
    const e = new Error('楽天APIエラー (' + code + '): ' + detail);
    e.httpCode = code;
    throw e;
  }
  return json;
}

function normalizeRakutenItem_(raw) {
  const item = raw.Item || raw;
  const images = (item.mediumImageUrls || []).map(function (u) { return typeof u === 'string' ? u : u.imageUrl; });
  return {
    code: item.itemCode,
    name: item.itemName,
    catchcopy: item.catchcopy || '',
    caption: String(item.itemCaption || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800),
    price: Number(item.itemPrice),
    url: item.itemUrl,
    affiliateUrl: item.affiliateUrl || item.itemUrl,
    shop: item.shopName,
    reviewCount: Number(item.reviewCount || 0),
    reviewAverage: Number(item.reviewAverage || 0),
    images: images.map(largeRakutenImage_)
  };
}

/** 楽天の画像URLのサイズ指定を大きめ（600x600）に変える */
function largeRakutenImage_(url) {
  if (!url) return url;
  if (/_ex=\d+x\d+/.test(url)) return url.replace(/_ex=\d+x\d+/, '_ex=600x600');
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + '_ex=600x600';
}

/**
 * 接続テスト：エンドポイントとヘッダーの組み合わせを順に試し、
 * 動いたものをスクリプト プロパティに保存して、商品を5件ログに出す。
 */
function rakutenTest() {
  const params = {
    applicationId: requireProp_('RAKUTEN_APP_ID'),
    accessKey: requireProp_('RAKUTEN_ACCESS_KEY'),
    affiliateId: requireProp_('RAKUTEN_AFFILIATE_ID'),
    format: 'json',
    formatVersion: 2,
    genreId: GENRES.interior.id,
    sort: '-reviewCount',
    hits: 5,
    imageFlag: 1
  };
  const modes = ['referer', 'both', 'origin', 'none'];
  const errors = [];

  for (let i = 0; i < RAKUTEN_ENDPOINTS.length; i++) {
    for (let j = 0; j < modes.length; j++) {
      try {
        const json = rakutenFetch_(RAKUTEN_ENDPOINTS[i], params, modes[j]);
        props_().setProperties({ RAKUTEN_ENDPOINT: RAKUTEN_ENDPOINTS[i], RAKUTEN_HEADER_MODE: modes[j] });
        Logger.log('接続成功：' + RAKUTEN_ENDPOINTS[i] + '（ヘッダー：' + modes[j] + '）');
        (json.Items || []).map(normalizeRakutenItem_).forEach(function (it, n) {
          Logger.log((n + 1) + '. ' + it.name.slice(0, 50) + ' ／ ' + it.price + '円 ／ ★' +
            it.reviewAverage + '（' + it.reviewCount + '件）\n   画像: ' + (it.images[0] || 'なし'));
        });
        return;
      } catch (e) {
        errors.push(RAKUTEN_ENDPOINTS[i].split('/').pop() + ' / ' + modes[j] + ' → ' + e.message);
      }
    }
  }
  Logger.log('すべての組み合わせで失敗しました。\n' + errors.join('\n'));
}
