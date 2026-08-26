"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { enrichSpotWithLocality } = require("./tama-localities");

const DISCORD_API = "https://discord.com/api/v10";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const PHOTON = "https://photon.komoot.io/api/";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const GSI_ADDRESS_SEARCH = "https://msearch.gsi.go.jp/address-search/AddressSearch";
const USER_AGENT = "tamadev-discord-spots/8.0 (+https://tamadev.jp/map/)";

const DATA_VERSION = "14";

const SPOTS_PATH = path.join(__dirname, "..", "map", "spots.json");

const MAX_MESSAGE_PAGES = 5;
const MAX_REACTION_PAGES = 5;
const MAP_REACTION = "🗺️";

const CITIES =
  "多摩市|八王子市|立川市|調布市|稲城市|府中市|日野市|町田市|国立市|国分寺市|小金井市|小平市|東村山市|東大和市|武蔵村山市|昭島市|福生市|羽村市|青梅市|あきる野市|西東京市|武蔵野市|三鷹市|狛江市|清瀬市|東久留米市|川崎市";

const AREAS = new RegExp(
  `${CITIES}|聖蹟桜ヶ丘|多摩センター|南大沢|立川|調布|稲城|府中|永山|八王子|川崎`,
  "u"
);

// HTML取得が不安定な公式サイトや、同名店舗が多い紹介記事の住所を補う。
// 住所は店舗の公式サイト・紹介元に掲載されている公開情報のみを使用する。
const SOURCE_ADDRESS_HINTS = [
  {
    matches: (url) => url.hostname === "cerian.net" || url.hostname === "www.cerian.net",
    address: "東京都八王子市台町4丁目45-7"
  },
  {
    matches: (url) =>
      url.hostname === "www.tamatebakonet.jp" &&
      url.pathname === "/shop/detail/id=9664",
    address: "東京都立川市錦町1-4-7"
  },
  {
    matches: (url) =>
      (url.hostname === "instagram.com" || url.hostname.endsWith(".instagram.com")) &&
      /^\/spice_ekkyo11(?:\/|$)/i.test(url.pathname),
    address: "東京都立川市曙町3-4-3"
  },
  {
    matches: (url) => url.hostname === "kawa-sui.com" || url.hostname === "www.kawa-sui.com",
    name: "カワスイ 川崎水族館",
    address: "神奈川県川崎市川崎区日進町1-11"
  },
  {
    matches: (url) => url.hostname === "ubriaco.ne.jp" || url.hostname === "www.ubriaco.ne.jp",
    name: "UBRIACO（ウブリアーコ）",
    address: "東京都多摩市関戸4-4-1"
  }
];

function findSourcePlaceHint(value) {
  try {
    const url = new URL(value);
    return SOURCE_ADDRESS_HINTS.find((hint) => hint.matches(url)) || null;
  } catch {
    return null;
  }
}

function findSourceAddressHint(value) {
  return findSourcePlaceHint(value)?.address || "";
}

function normalizeAreaHint(value) {
  const hint = String(value || "").trim();

  const aliases = {
    聖蹟桜ヶ丘: "多摩市",
    多摩センター: "多摩市",
    永山: "多摩市",
    南大沢: "八王子市",
    西八王子: "八王子市",
    八王子: "八王子市",
    立川: "立川市",
    調布: "調布市",
    稲城: "稲城市",
    府中: "府中市",
    川崎: "川崎市"
  };

  return aliases[hint] || hint;
}

function matchesAreaHint(result, areaHint) {
  const expected = normalizeAreaHint(areaHint).replace(/市$/u, "");

  if (!expected) {
    return true;
  }

  const address = result?.address || {};
  const actual = [
    address.city,
    address.town,
    address.village,
    address.county,
    address.municipality,
    result?.display_name,
    result?.properties?.title,
    result?.properties?.city,
    result?.properties?.district,
    result?.properties?.county
  ]
    .filter(Boolean)
    .join(" ");

  return actual.includes(expected);
}

const GOOGLE_HOSTS = new Set([
  "maps.app.goo.gl",
  "goo.gl",
  "google.com",
  "www.google.com",
  "maps.google.com",
  "google.co.jp",
  "www.google.co.jp"
]);

let previousGeocodingAt = 0;

const googleMapsInformationCache = new Map();

function requiredEnvironmentVariable(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} が未設定です。GitHub Secretsを確認してください。`);
  }

  return value;
}

function cleanText(value, length = 160) {
  return String(value || "")
    .replace(/https?:\/\/[^\s<>]+/g, "")
    .replace(/<@!?\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, length);
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(
      /&#(\d+);/g,
      (_, code) =>
        String.fromCodePoint(Number(code))
    )
    .replace(
      /&#x([\da-f]+);/gi,
      (_, code) =>
        String.fromCodePoint(Number.parseInt( code, 16 ) ));
}

function isValidPosition(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= 35.42 &&
    latitude <= 35.90 &&
    longitude >= 138.95 &&
    longitude <= 139.80
  );
}

function makePosition(latitude, longitude) {
  const lat = Number(latitude);

  const lon = Number(longitude);

  return isValidPosition(lat, lon)
    ? [lat, lon]
    : null;
}

function parseCoordinatePair(value) {
  const match = String(value || "").match(/(-?\d{1,2}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)/);

  return match
    ? makePosition(match[1], match[2])
    : null;
}

function extractCoordinatesFromUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  let decoded;

  try {
    decoded = decodeURIComponent(url.toString());
  } catch {
    decoded = url.toString();
  }

  const patterns = [
    /@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/,
    /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/
  ];

  for (const pattern of patterns) {
    const match = decoded.match(pattern);

    const position = match
      ? makePosition(match[1], match[2])
      : null;

    if (position) {
      return position;
    }
  }

  for (const key of [
    "q",
    "query",
    "destination",
    "ll",
    "center"
  ]) {
    const position = parseCoordinatePair(url.searchParams.get(key));

    if (position) {
      return position;
    }
  }

  return null;
}

function extractUrls(message) {
  const values = [
    message.content || ""
  ];

  for (const embed of message.embeds || []) {
    values.push(embed.url || "", embed.description || "");

    for (const field of embed.fields || []) {
      values.push(field.value || "");
    }
  }

  const matches = values
      .join("\n")
      .match(/https?:\/\/[^\s<>]+/g) || [];

  return [
    ...new Set(matches.map( (url) => url.replace( /[),。、]+$/, "")
      )
    )
  ];
}

function extractMapSections(message) {
  const content = message.content || "";

  const matches = [
    ...content.matchAll(/https?:\/\/[^\s<>]+/g)
  ]
    .map(
      (match) => ({
        match,
        url: match[0].replace(
            /[),。、]+$/,
            ""
          )
      })
    )
    .filter((item) => isGoogleMapsUrl(item.url));

  if (matches.length === 0) {
    return [];
  }

  const sections = [];

  let previousUrlEnd = 0;

  for (const item of matches) {
    sections.push({
      url: item.url,
      description: cleanText(content.slice( previousUrlEnd, item.match.index ), 300)
    });

    previousUrlEnd = item.match.index +
      item.match[0].length;
  }

  const trailingText = cleanText(content.slice(previousUrlEnd), 200);

  if (trailingText) {
    const last = sections.at(-1);

    last.description = cleanText([last.description, trailingText] .filter(Boolean) .join(" "), 300);
  }

  return sections;
}

// 「【府中市】店名 → URL → 説明」が複数続く投稿を店舗単位に分割する。
// 埋め込みの別店舗URLが混ざらないよう、各区画の本文URLのみを使う。
function extractLinkedPlaceSections(message) {
  const content = String(message.content || "");
  const headings = [...content.matchAll(/(?:^|\n)[\t ]*[【［\[]\s*([^】］\]\n]{1,20})\s*[】］\]][\t ]*([^\n]*)/gu)];

  if (headings.length < 2) return [];

  return headings.map((heading, index) => {
    const start = heading.index + (heading[0].startsWith("\n") ? 1 : 0);
    const end = headings[index + 1]?.index ?? content.length;
    const sectionContent = content.slice(start, end).trim();
    const urls = [...sectionContent.matchAll(/https?:\/\/[^\s<>]+/g)]
      .map((match) => match[0].replace(/[),。、]+$/, ""));

    return {
      content: sectionContent,
      name: normalizePlaceName(heading[2]),
      urls
    };
  }).filter((section) => section.urls.length > 0);
}

function isGoogleMapsUrl(value) {
  try {
    const url = new URL(value);

    return (
      GOOGLE_HOSTS.has(url.hostname) &&
      (
        url.hostname ===
          "maps.app.goo.gl" ||

        url.hostname ===
          "maps.google.com" ||

        url.pathname.startsWith("/maps") ||

        url.pathname.startsWith("/place/")
      )
    );
  } catch {
    return false;
  }
}

function isInstagramUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "instagram.com" || hostname.endsWith(".instagram.com");
  } catch {
    return false;
  }
}

function extractInstagramPlaceNames(message) {
  const names = [];

  for (const embed of message.embeds || []) {
    for (const value of [embed.title, embed.author?.name]) {
      const name = normalizePlaceName(
        String(value || "")
          .replace(/\s*[（(][@＠][^)）]+[)）].*$/u, "")
          .replace(/\s*[@＠][a-z\d_.]+.*$/iu, "")
          .replace(/\s*[・·•|｜-]\s*(?:Instagram|インスタグラム).*$/iu, "")
      );

      if (name && !names.includes(name)) names.push(name);
    }
  }

  return names;
}

function normalizePlaceName(value) {
  let name = cleanText(decodeHtmlEntities(value), 160)
    .replace(
      /\s*[|｜]\s*(食べログ|Instagram|インスタグラム|note|Google マップ|Google Maps|ラーメンデータベース).*$/iu,
      ""
    )
    .replace(/\s*[-–—]\s*(食べログ|Instagram|インスタグラム|note|ラーメンデータベース).*$/iu, "")
    .replace(/\s*[-–—]\s*(Google Maps|Google マップ|グーグルマップ)\s*$/iu, "")
    .replace(/\s*[（(][@＠][^)）]+[)）].*$/u, "")
    .replace(/\s*[@＠][a-zA-Z0-9_.]+.*$/u, "")
    .replace(
      /\s*[（(][^()（）]*(?:カフェ|グルメ|うどん|そば|レストラン|食堂|パン|ラーメン)[^()（）]*[)）]\s*$/u,
      ""
    )
    .replace(/(?:クーポン|店舗情報|公式サイト|公式ホームページ|Instagram profile)\s*$/iu, "")
    .replace(
      /^(?:東京都)?(?:多摩市|八王子市|立川市|調布市|稲城市|府中市)\s+(?:うどん|カフェ|ラーメン|グルメ)\s+/u,
      ""
    )
    .replace(/(?:を紹介します|を紹介する|をご紹介|のご紹介)\s*$/u, "")
    .trim();

  const quoted = name.match(/^([^「」『』|｜]{1,30})[「『]([^」』]{1,50})[」』]/u);

  if (quoted) {
    name = /うどん|そば|カフェ|珈琲|書店|食堂|レストラン|パン/u.test(quoted[1])
        ? `${quoted[1].trim()} ${quoted[2].trim()}`
        : quoted[2].trim();
  }

  name = cleanText(name, 80).replace(/^[「『【]+|[」』】]+$/gu, "").trim();

  if (/^(?:〒\s*)?\d{3}(?:[-−ー]\d{4})?(?:\s|$)/u.test(name)) {
    return "";
  }

  if (/^〒/u.test(name)) {
    return "";
  }

  if (/^(?:トップ|ホーム|Google|Google Maps|Google マップ|地図)$/iu.test(name)) {
    return "";
  }

  if (/^(?:日本[、,\s]*)?(?:東京都)?(?:多摩市|府中市|八王子市|立川市|調布市|稲城市|日野市|町田市)[^\s]*\d/u.test(name)) {
    return "";
  }

  return name;
}

// 店名を取得できなかったときに作られた説明用の仮タイトルは、
// 実在する施設名として地図へ掲載しない。
function isPlaceholderPlaceName(value) {
  const name = cleanText(value, 100);

  return (
    /(?:駅周辺|周辺)のおすすめスポット(?:\s*\d+)?$/u.test(name) ||
    /^(?:多摩地域|おすすめスポット)(?:のおすすめスポット)?(?:\s*\d+)?$/u.test(name)
  );
}

function extractAddressFromText(value) {
  const text = decodeHtmlEntities(String(value || ""))
    .replace(/<\/(?:p|div|li|td|th|address)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[０-９]/g, (character) => String.fromCharCode( character.charCodeAt(0) - 0xfee0)
    );

  const patterns = [
    new RegExp(
      `(?:〒\\s*\\d{3}[-ー]\\d{4}\\s*)?((?:東京都)?(?:${CITIES})[一-龠ぁ-んァ-ヶー]{1,20}(?:\\d{1,4}丁目)?\\d{1,4}(?:[-−ー丁目番地号]\\d{1,4}){1,4}(?:号)?)`,
      "u"
    ),
    new RegExp(
      `(?:〒\\s*\\d{3}[-ー]\\d{4}\\s*)?((?:東京都)?(?:${CITIES})[一-龠ぁ-んァ-ヶー]{1,20}\\d{1,4}丁目\\d{1,4}(?:番(?:地)?\\d{1,4})?(?:号)?)`,
      "u"
    )
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) {
      return cleanText(match[1], 100 ).replace( /[−ー]/g, "-");
    }
  }

  return "";
}

function getMeta(html, names) {
  const wanted = new Set(names.map( (name) => name.toLowerCase() ));

  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const key = tag
      .match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1]
      ?.toLowerCase();

    if (!wanted.has(key)) {
      continue;
    }

    const content = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);

    if (content) {
      return decodeHtmlEntities(content[1] || content[2]);
    }
  }

  return "";
}

function jsonLdEntries(html) {
  const results = [];

  const visit = (
    value,
    depth = 0
  ) => {
    if (
      !value ||
      depth > 7
    ) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => visit( item, depth + 1 ));

      return;
    }

    if (typeof value !== "object") {
      return;
    }

    results.push(value);

    for (const key of [
      "@graph",
      "mainEntity",
      "itemListElement",
      "item",
      "location",
      "about"
    ]) {
      visit(value[key], depth + 1);
    }
  };

  const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (
    const match
    of html.matchAll(pattern)
  ) {
    try {
      visit(JSON.parse(match[1] .trim() .replace( /^<!--|-->$/g, ""))
      );
    } catch {
      continue;
    }
  }

  return results;
}

function structuredAddress(value) {
  if (typeof value === "string") {
    return (
      extractAddressFromText(value) ||

      cleanText(value, 100 ));
  }

  if (
    !value ||
    typeof value !== "object"
  ) {
    return "";
  }

  const address = [value.addressRegion, value.addressLocality, value.streetAddress]
    .filter(Boolean)
    .join("");

  return (
    extractAddressFromText(address) ||

    (
      /\d/.test(address)
        ? cleanText(address, 100 ) : "" ));
}

function extractCoordinatesFromHtml(html) {
  const latitude = getMeta(html, [ "place:location:latitude", "latitude" ]);

  const longitude = getMeta(html, [ "place:location:longitude", "longitude" ]);

  const metaPosition = latitude &&
    longitude &&
    makePosition(latitude, longitude);

  if (metaPosition) {
    return metaPosition;
  }

  const geoPosition = parseCoordinatePair(getMeta(html, [ "geo.position", "icbm" ]));

  if (geoPosition) {
    return geoPosition;
  }

  const patterns = [
    /"latitude"\s*:\s*"?(-?\d+(?:\.\d+)?)"?[\s\S]{0,120}?"longitude"\s*:\s*"?(-?\d+(?:\.\d+)?)/i,

    /"lat"\s*:\s*"?(-?\d+(?:\.\d+)?)"?[\s\S]{0,100}?"(?:lng|lon)"\s*:\s*"?(-?\d+(?:\.\d+)?)/i,

    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,

    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    const position = match
      ? makePosition(match[1], match[2])
      : null;

    if (position) {
      return position;
    }
  }

  const mapPattern =
    /(?:src|href)\s*=\s*["']([^"']+(?:google\.com\/maps|google\.co\.jp\/maps)[^"']*)["']/gi;

  for (
    const match
    of html.matchAll(mapPattern)
  ) {
    const position = extractCoordinatesFromUrl(decodeHtmlEntities(match[1]));

    if (position) {
      return position;
    }
  }

  return null;
}

function decodePage(buffer, contentType) {
  const bytes = new Uint8Array(buffer);

  const initial = new TextDecoder("ascii").decode(bytes.slice( 0, 8192 ));

  const charset = contentType.match(/charset\s*=\s*([^;\s]+)/i)?.[1] ||

    initial.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ||

    initial.match(/encoding\s*=\s*["']([^"']+)/i)?.[1] ||

    "utf-8";

  let decoded;

  try {
    decoded = new TextDecoder(charset).decode(bytes);
  } catch {
    decoded = new TextDecoder("utf-8").decode(bytes);
  }

  const replacementCount = (
    decoded.match(/\uFFFD/g) || []
  ).length;

  if (replacementCount > 5) {
    for (const encoding of ["shift_jis", "euc-jp", "utf-8"]) {
      try {
        const candidate = new TextDecoder(encoding).decode(bytes);

        const errors = (
          candidate.match(/\uFFFD/g) || []
        ).length;

        if (
          errors <
          replacementCount
        ) {
          console.log(`文字コードを補正: ${encoding}`);

          return candidate;
        }
      } catch {
        continue;
      }
    }
  }

  console.log(`文字コード: ${charset}`);

  return decoded;
}

async function fetchPageInformation(url) {
  if (
    !url ||
    isGoogleMapsUrl(url)
  ) {
    return null;
  }

  try {
    console.log(`リンク先を確認: ${url}`);

    const response = await fetch(
      url,
      {
        redirect: "follow",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "ja,en;q=0.8"
        },
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!response.ok) {
      console.warn(`リンク先を取得できませんでした: ${response.status} / ${url}`);

      return null;
    }

    const contentType = response.headers.get("content-type") || "";

    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      await response.body?.cancel();

      return null;
    }

    const html = decodePage(await response.arrayBuffer(), contentType ).slice( 0, 1200000);

    const entries = jsonLdEntries(html);

    const preferred = entries
      .map(
        (entry) => {
          const geo = entry.geo ||
            entry.location?.geo ||
            {};

          const position = makePosition(geo.latitude ?? geo.lat, geo.longitude ?? geo.lng ?? geo.lon);

          const address = structuredAddress(entry.address || entry.location?.address);

          const type = String(entry["@type"] || "");

          const score = (
              position
                ? 5
                : 0
            ) +

            (
              address
                ? 4
                : 0
            ) +

            (
              /Restaurant|Store|LocalBusiness|Place|Cafe|FoodEstablishment/i.test(type)
                ? 3
                : 0
            ) +

            (
              entry.name
                ? 1
                : 0
            );

          return {
            entry,
            position,
            address,
            score
          };
        }
      )
      .sort(( left, right) =>
          right.score -
          left.score
      )[0];

    const title = getMeta(html, [ "og:title", "twitter:title" ]) ||

      html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||

      "";

    const description = getMeta(html, ["description", "og:description", "twitter:description"]);

    const address = preferred?.address ||

      extractAddressFromText(getMeta( html, ["og:street-address", "street-address", "streetaddress"] )) ||

      extractAddressFromText(description) ||

      extractAddressFromText(html.slice( 0, 500000 ));

    const information = {
      name: normalizePlaceName(preferred?.entry?.name || title),
      address,
      position: preferred?.position ||
        extractCoordinatesFromHtml(html),
      description: cleanText(description, 200)
    };

    console.log(
      `リンク先の情報: ` +
      `店名=${information.name || "不明"} / ` +
      `住所=${information.address || "不明"} / ` +
      `座標=${information.position?.join(",") || "不明"}`
    );

    return information;
  } catch (
    error
  ) {
    console.warn(`リンク先の取得に失敗しました: ${url} / ${error.message}`);

    return null;
  }
}

function extractAddress(message) {
  const values = [
    message.content || "",
    ...(message.embeds || []).flatMap(
      (embed) => [
        embed.title || "",
        embed.description || "",
        ...(embed.fields || []).map((field) => field.value || "" ) ])
  ];

  for (const value of values) {
    const address = extractAddressFromText(value);

    if (address) {
      return address;
    }
  }

  return "";
}

function extractPlaceCandidates(message, mapsUrl, pages = []) {
  const candidates = [];

  const add = (value) => {
    const name = normalizePlaceName(value);

    if (
      name &&
      !candidates.includes(name) &&
      !name.includes("�")
    ) {
      candidates.push(name);
    }
  };

  const explicit = (
    message.content || ""
  ).match(/(?:場所|施設|会場|店名|名称|スポット)\s*[：:]\s*([^\n]+)/u);

  if (explicit) {
    add(explicit[1]);
  }

  if (mapsUrl) {
    try {
      const url = new URL(mapsUrl);

      const match = decodeURIComponent(url.pathname).match(/\/place\/([^/]+)/);

      if (match) {
        add(match[1].replace( /\+/g, " " ));
      }

      for (const key of ["query", "q", "destination"]) {
        const value = url.searchParams.get(key);

        if (
          value &&
          !parseCoordinatePair(value)
        ) {
          add(value);
        }
      }
    } catch {
      // URL解析に失敗した場合は、ほかの情報を使用します。
    }
  }

  for (const page of pages) {
    add(page.name);
  }

  for (const embed of message.embeds || []) {
    add(embed.title);
  }

  const texts = [
    message.content || "",
    ...(message.embeds || []).flatMap((embed) => [ embed.title || "", embed.description || "" ])
  ];

  for (const text of texts) {
    const matches = text.matchAll(/[「『]([^」』]{1,60})[」』]/gu);

    for (const match of matches) {
      add(match[1]);
    }
  }

  const lines = (
    message.content || ""
  )
    .split(/\r?\n/)
    .map((line) => cleanText( line, 100 ))
    .filter(Boolean);

  for (const line of lines) {
    if (
      line.length <= 40 &&
      !/おすすめです|美味しいです|おいしいです|ある.*です/u.test(line)
    ) {
      add(line);
    }
  }

  if (
    candidates.length === 0 &&
    lines.length > 0
  ) {
    add(lines[0]);
  }

  return candidates;
}

function extractAreaHint(message, pages = []) {
  const text = [
    message.content || "",
    ...(message.embeds || []).flatMap((embed) => [ embed.title || "", embed.description || "" ]),
    ...pages.flatMap((page) => [ page.address || "", page.description || "", page.name || "" ])
  ].join(" ");

  return (
    text.match(AREAS)?.[0] ||

    ""
  );
}

function extractDescription(message, name) {
  const lines = (
    message.content || ""
  )
    .split(/\r?\n/)
    .map((line) => cleanText( line, 200 ))
    .filter((line) => line && line !== name && !/^(場所|施設|会場|店名|名称|スポット|ジャンル|種類|分類)\s*[：:]/u.test(line));

  if (lines.length > 0) {
    return cleanText(lines.join(" "), 160);
  }

  const embed = (
    message.embeds || []
  ).find((item) => item.description || item.title);

  return cleanText(embed?.description || embed?.title || "コミュニティで紹介されたスポット。", 160);
}
const GENRES = [
  "中華",
  "ラーメン",
  "うどん・そば",
  "和食",
  "イタリアン",
  "洋食",
  "カレー",
  "パン",
  "スイーツ",
  "コーヒー",
  "カフェ",
  "居酒屋",
  "書店・図書館",
  "公園・レジャー",
  "その他"
];

function classifyGenre(message, ...additionalTexts) {
  const messageText = [
    message.content || "",
    ...(message.embeds || []).flatMap((embed) => [ embed.title || "", embed.description || "" ]),
    ...additionalTexts
  ].join(" ");

  // Discord投稿で明示されていれば最優先。
  // 例:
  // ジャンル：中華
  // 分類: コーヒー
  const explicitGenre = messageText.match(/(?:ジャンル|種類|分類)\s*[：:]\s*([^\s、,]+)/u)?.[1];

  if (explicitGenre) {
    const matched = GENRES.find((genre) => genre === explicitGenre);

    if (matched) {
      return matched;
    }
  }

  const genrePatterns = [
    [
      "イタリアン",
      /イタリアン|イタリア料理|イタリア食堂|トラットリア|リストランテ|ピッツェリア/iu
    ],
    [
      "中華",
      /中華|中国料理|四川|広東|上海料理|台湾料理|餃子|点心/u
    ],
    [
      "ラーメン",
      /ラーメン|らーめん|拉麺|つけ麺|中華そば/u
    ],
    [
      "うどん・そば",
      /うどん|饂飩|そば|蕎麦/u
    ],
    [
      "カレー",
      /カレー|咖喱/u
    ],
    [
      "パン",
      /パン屋|ベーカリー|bakery|bread/u
    ],
    [
      "コーヒー",
      /コーヒー|珈琲|coffee|roaster|焙煎/u
    ],
    [
      "カフェ",
      /カフェ|cafe|喫茶|茶店/u
    ],
    [
      "スイーツ",
      /ケーキ|洋菓子|和菓子|スイーツ|ジェラート|アイス|パフェ/u
    ],
    [
      "居酒屋",
      /居酒屋|酒場|ビール|beer|日本酒|焼鳥|焼き鳥/u
    ],
    [
      "和食",
      /和食|寿司|鮨|天ぷら|天麩羅|とんかつ|定食|おにぎり|おむすび/u
    ],
    [
      "洋食",
      /洋食|イタリアン|フレンチ|パスタ|ピザ|ハンバーグ/u
    ],
    [
      "書店・図書館",
      /書店|本屋|図書館|ブック/u
    ],
    [
      "公園・レジャー",
      /公園|動物園|水族館|遊園地|レジャー|博物館|美術館/u
    ]
  ];

  // 店名・投稿本文・紹介記事の順に判定し、記事内の別料理を優先しない。
  const prioritizedTexts = [
    additionalTexts[0] || "",
    message.content || "",
    ...(message.embeds || []).map((embed) => embed.title || ""),
    ...additionalTexts.slice(1),
    ...(message.embeds || []).map((embed) => embed.description || "")
  ];

  for (const text of prioritizedTexts) {
    for (const [genre, pattern] of genrePatterns) {
      if (pattern.test(text)) return genre;
    }
  }

  return "その他";
}
function classifySpot(message) {
  const text = [
    message.content || "",
    ...(message.embeds || []).map(
      (embed) =>
        `${embed.title || ""} ${embed.description || ""}`
    )
  ].join(" ");

  if (/イベント|開催|お祭り|祭り|フェス|展示|ワークショップ|勉強会|体験会/u.test(text)) {
    return "event";
  }

  if (/お店|飲食|カフェ|珈琲|コーヒー|パン屋|レストラン|ランチ|食堂|書店|うどん|カレー|ラーメン|酒店/u.test(text)) {
    return "shop";
  }

  return "spot";
}

function wait(milliseconds) {
  return new Promise(
    (resolve) => {
      setTimeout(
        resolve,
        milliseconds
      );
    }
  );
}

async function requestDiscord(endpoint, token) {
  for (
    let attempt = 0;
    attempt < 3;
    attempt += 1
  ) {
    const response = await fetch(
      DISCORD_API + endpoint,
      {
        headers: {
          Authorization: `Bot ${token}`,
          "User-Agent": USER_AGENT
        },
        signal: AbortSignal.timeout(15000)
      }
    );

    if (
      response.status === 429 &&
      attempt < 2
    ) {
      const body = await response
          .json()
          .catch(() => ({}));

      await wait(Math.max( Number(body.retry_after || 1) * 1000, 1000 ));

      continue;
    }

    if (!response.ok) {
      throw new Error(`Discord APIへの接続に失敗しました: ${response.status}`);
    }

    return response.json();
  }

  throw new Error("Discord APIのリクエスト制限に達しました。");
}

async function fetchChannelMessages(channelId, token) {
  const messages = [];

  let before = "";

  for (
    let page = 0;
    page < MAX_MESSAGE_PAGES;
    page += 1
  ) {
    const parameters = new URLSearchParams({
        limit: "100"
      });

    if (before) {
      parameters.set("before", before);
    }

    const batch = await requestDiscord(
        `/channels/${encodeURIComponent(channelId)}/messages?${parameters}`,
        token
      );

    if (!Array.isArray(batch)) {
      throw new Error("Discordの投稿一覧の形式が正しくありません。");
    }

    messages.push(...batch);

    if (batch.length < 100) {
      break;
    }

    before = batch.at(-1).id;
  }

  return messages;
}

function normalizeEmoji(value) {
  return String(value || "").replace(/\uFE0F/g, "");
}

function getMapReaction(message) {
  return (
    message.reactions || []
  ).find((reaction) => normalizeEmoji(reaction.emoji?.name) === normalizeEmoji(MAP_REACTION));
}

async function wasApprovedByOwner(message, reaction, channelId, token, approverId) {
  let after = "";

  for (
    let page = 0;
    page < MAX_REACTION_PAGES;
    page += 1
  ) {
    const parameters = new URLSearchParams({
        limit: "100"
      });

    if (after) {
      parameters.set("after", after);
    }

    const users = await requestDiscord(
        `/channels/${encodeURIComponent(channelId)}` +
        `/messages/${encodeURIComponent(message.id)}` +
        `/reactions/${encodeURIComponent(reaction.emoji.name)}?${parameters}`,
        token
      );

    if (
      users.some((user) => user.id === approverId || user.id === message.author.id )) {
      return true;
    }

    if (users.length < 100) {
      return false;
    }

    after = users.at(-1).id;
  }

  return false;
}

async function expandMapsUrl(url) {
  const information = await fetchGoogleMapsInformation(url);
  return information.url || url;
}

async function fetchGoogleMapsInformation(originalUrl) {
  if (!originalUrl || !isGoogleMapsUrl(originalUrl)) {
    return { url: originalUrl || "", name: "", position: null };
  }

  if (googleMapsInformationCache.has(originalUrl)) {
    return googleMapsInformationCache.get(originalUrl);
  }

  const information = {
    url: originalUrl,
    name: "",
    address: "",
    position: extractCoordinatesFromUrl(originalUrl)
  };

  try {
    const response = await fetch(originalUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "ja,en;q=0.8",
        Accept: "text/html,application/xhtml+xml"
      },
      signal: AbortSignal.timeout(20000)
    });

    information.url = response.url || originalUrl;
    information.position = extractCoordinatesFromUrl(information.url) || information.position;

    const parsedUrl = new URL(information.url);
    const pathMatch = decodeURIComponent(parsedUrl.pathname).match(/\/place\/([^/]+)/);

    if (pathMatch) {
      const raw = pathMatch[1].replace(/\+/g, " ");
      const directName = normalizePlaceName(raw);
    
      if (directName) {
        information.name = directName;
      } else {
        const englishName = raw.match(/(?:^|[\s\u3000])([A-Za-z][A-Za-z0-9&.'’ -]{2,})$/u)?.[1];
    
        const trailingName = raw.match(/(?:丁目|番地|番|号|Chome|[−ー-]\d+)\s+([^,]+)$/iu)?.[1];
    
        information.name = normalizePlaceName(englishName || trailingName || "");
    
        information.address = raw
          .replace(/^〒\s*\d{3}[-−ー]?\d{0,4}\s*/u, "")
          .trim();
    
        if (
          information.name &&
          information.address.endsWith(information.name)
        ) {
          information.address = information.address
            .slice(0, -information.name.length)
            .trim();
        }
      }
    }
    
    const contentType = response.headers.get("content-type") || "";

    if (
      response.ok &&
      /text\/html|application\/xhtml\+xml/i.test(contentType)
    ) {
      const html = decodePage(await response.arrayBuffer(), contentType).slice(0, 1800000);

      const title = getMeta(html, ["og:title", "twitter:title"]) ||
        html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
        "";

      const titleCandidates = [
        title.split(/\s*[·•]\s*/u)[0],
        title,
        ...jsonLdEntries(html).map((entry) => entry.name || "")
      ];

      for (const candidate of titleCandidates) {
        const normalized = normalizePlaceName(candidate);

        if (
          normalized &&
          !/^(?:Google Maps|Google マップ|グーグルマップ)$/iu.test(normalized)
        ) {
          information.name = normalized;
          break;
        }
      }

    information.address =
      extractAddressFromText(getMeta(html, ["og:description", "description"])) || information.address;
    } else {
      await response.body?.cancel();
    }

    console.log(
      `Googleマップ: 店名=${information.name || "不明"} / ` +
      `座標=${information.position?.join(",") || "不明"}`
    );
  } catch (error) {
    console.warn(`Googleマップの解析に失敗しました: ${originalUrl} / ${error.message}`);
  }

  googleMapsInformationCache.set(originalUrl, information);
  return information;
}

async function findPlace(query, areaHint = "") {
  const elapsed = Date.now() -
    previousGeocodingAt;

  if (elapsed < 1100) {
    await wait(1100 - elapsed);
  }

  previousGeocodingAt = Date.now();

  const url = new URL(NOMINATIM);

  const parameters = {
    format: "jsonv2",
    q: query,
    countrycodes: "jp",
    addressdetails: "1",
    limit: "5",
    viewbox: "138.95,35.90,139.80,35.42",
    bounded: "1"
  };

  for (
    const [key, value] of Object.entries(parameters)
  ) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(
      url,
      {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "ja"
        },
        signal: AbortSignal.timeout(15000)
      }
    );

  if (!response.ok) {
    throw new Error(`場所の検索に失敗しました: ${response.status} / ${query}`);
  }

  const results = await response.json();

  const result = results.find((candidate) => matchesAreaHint(candidate, areaHint));

  if (!result && results.length > 0 && areaHint) {
    console.warn(
      `地域の異なる検索結果を除外: ${query} / ` +
      `希望=${normalizeAreaHint(areaHint)} / ` +
      `候補=${results.map((candidate) => candidate.address?.city || candidate.display_name || "不明").join("、")}`
    );
  }

  const position = result
      ? makePosition(result.lat, result.lon)
      : null;

  if (!position) {
    return null;
  }

  const address = result.address || {};

  return {
    position,
    area: address.city ||
      address.town ||
      address.village ||
      address.county ||
      "多摩地域"
  };
}

async function findAddressWithGsi(address, areaHint = "") {
  if (!address || !/\d/u.test(address)) {
    return null;
  }

  try {
    const url = new URL(GSI_ADDRESS_SEARCH);
    url.searchParams.set("q", address);

    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "ja"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      console.warn(`国土地理院の住所検索に失敗: ${response.status} / ${address}`);
      return null;
    }

    const results = await response.json();
    const result = results.find((candidate) => matchesAreaHint(candidate, areaHint));
    const coordinates = result?.geometry?.coordinates;
    const position = Array.isArray(coordinates)
      ? makePosition(coordinates[1], coordinates[0])
      : null;

    if (!position) {
      return null;
    }

    const title = result.properties?.title || address;

    return {
      position,
      area: title.match(AREAS)?.[0] || normalizeAreaHint(areaHint) || "多摩地域"
    };
  } catch (error) {
    console.warn(`国土地理院の住所検索を利用できません: ${address} / ${error.message}`);
    return null;
  }
}

function normalizeSearchName(value) {
  return normalizePlaceName(value)
    .normalize("NFKC")
    .replace(/[\s・·•「」『』()（）_-]/gu, "")
    .toLowerCase();
}

function namesMatch(left, right) {
  const first = normalizeSearchName(left);
  const second = normalizeSearchName(right);
  return Boolean(first && second && (first.includes(second) || second.includes(first)));
}

async function findInstagramPlaceWithPhoton(name, areaHint) {
  try {
    const url = new URL(PHOTON);
    url.searchParams.set("q", `${normalizeAreaHint(areaHint)} ${name}`.trim());
    url.searchParams.set("limit", "10");
    url.searchParams.set("bbox", "138.95,35.42,139.80,35.90");

    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "ja" },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) return null;

    const data = await response.json();
    const feature = (data.features || []).find((item) =>
      namesMatch(name, item.properties?.name) && matchesAreaHint(item, areaHint)
    );
    const coordinates = feature?.geometry?.coordinates;
    const position = Array.isArray(coordinates)
      ? makePosition(coordinates[1], coordinates[0])
      : null;

    if (!position) return null;

    return {
      name: feature.properties.name || name,
      position,
      area: feature.properties.city || normalizeAreaHint(areaHint) || "多摩地域"
    };
  } catch (error) {
    console.warn(`店舗の補助検索に失敗しました: ${name} / ${error.message}`);
    return null;
  }
}

async function findInstagramPlaceWithOverpass(name, areaHint) {
  const city = normalizeAreaHint(areaHint);
  if (!city || !/市$/u.test(city)) return null;

  const escapedName = name
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/"/g, '\\"');
  const escapedCity = city.replace(/"/g, '\\"');
  const query = `[out:json][timeout:20];` +
    `area["boundary"="administrative"]["name"="${escapedCity}"]->.a;` +
    `nwr["name"~"${escapedName}",i](area.a);out center 10;`;

  try {
    const response = await fetch(OVERPASS, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(25000)
    });

    if (!response.ok) return null;

    const data = await response.json();
    const result = (data.elements || []).find((item) => namesMatch(name, item.tags?.name));
    const position = result
      ? makePosition(result.lat ?? result.center?.lat, result.lon ?? result.center?.lon)
      : null;

    return position ? { name: result.tags.name || name, position, area: city } : null;
  } catch (error) {
    console.warn(`地図データの店舗検索に失敗しました: ${name} / ${error.message}`);
    return null;
  }
}

async function findInstagramPlace(names, areaHint) {
  for (const name of names.slice(0, 3)) {
    console.log(`Instagramの店舗を検索: ${areaHint || "多摩地域"} ${name}`);
    const result = await findInstagramPlaceWithPhoton(name, areaHint) ||
      await findInstagramPlaceWithOverpass(name, areaHint);
    if (result) return result;
  }

  return null;
}

async function findPlaceFromCandidates(candidates, addresses, areaHint) {
  const searches = [];

  const add = (
    query,
    name,
    isAddress = false
  ) => {
    const normalized = cleanText(query, 120);

    if (
      normalized &&
      !searches.some((item) => item.query === normalized )) {
      searches.push({
        query: normalized,
        name,
        isAddress
      });
    }
  };

  for (const address of addresses) {
    add(address, candidates[0] || address, true);
  }

  for (
    const candidate
    of candidates.slice(0, 4 )) {
    const simplified = candidate
        .replace(/\s*[-–—]\s*.+$/u, "")
        .replace(/\s*[（(].*?[)）]\s*/gu, "")
        .replace(/\s+(?:クーポン|公式|店舗情報).*$/u, "")
        .trim();

    for (const name of new Set([candidate, simplified])) {
      if (
        areaHint &&
        !name.includes(areaHint)
      ) {
        add(
          `${areaHint} ${name}`,
          name
        );
      }

      add(name, name);
    }
  }

  for (
    const search
    of searches.slice(0, 10 )) {
    console.log(`場所を検索: ${search.query}`);

    let result = await findPlace(search.query, areaHint);

    if (!result && search.isAddress) {
      console.log(`住所を国土地理院でも検索: ${search.query}`);
      result = await findAddressWithGsi(search.query, areaHint);
    }

    if (result) {
      return {
        ...result,
        name: search.name
      };
    }
  }

  return null;
}

async function readExistingSpots() {
  try {
    const value = JSON.parse(await fs.readFile( SPOTS_PATH, "utf8" ));

    if (!Array.isArray(value)) {
      throw new Error("map/spots.json は配列である必要があります。");
    }

    return value;
  } catch (
    error
  ) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function convertMessageToSpot(message, previousSpot) {
  const revision = `${message.edited_timestamp || message.timestamp || ""}:v${DATA_VERSION}`;

  if (
    previousSpot &&
    previousSpot.revision === revision
  ) {
    return previousSpot;
  }

  const urls = extractUrls(message);

  // GoogleマップURLはDiscordの埋め込み情報ではなく、投稿者が本文へ
  // 明示的に貼ったものだけを使用する。紹介記事のプレビューに含まれる
  // 無関係なマップURLを拾うと、別の店や座標になることがあるため。
  const contentUrls = ((message.content || "").match(/https?:\/\/[^\s<>]+/g) || [])
    .map((url) => url.replace(/[),。、]+$/, ""));

  const originalMapsUrl = contentUrls.find(isGoogleMapsUrl);

  const mapsInformation = originalMapsUrl
    ? await fetchGoogleMapsInformation(originalMapsUrl)
    : null;

  const mapsUrl = mapsInformation?.url || "";

  const sourceUrls = urls
      .filter((url) => !isGoogleMapsUrl(url))
      .slice(0, 2);

  const pages = [];

  for (const url of sourceUrls) {
    const page = await fetchPageInformation(url);

    if (page) {
      pages.push(page);
    }
  }

  // 店名は紹介記事・投稿本文を優先し、Googleマップは補助情報にする。
  const candidatePages = [
    ...pages,
    ...(mapsInformation?.name ? [mapsInformation] : [])
  ];

  const instagramNames = sourceUrls.some(isInstagramUrl)
    ? extractInstagramPlaceNames(message)
    : [];
  const candidates = [...new Set([
    ...sourceUrls.map((url) => findSourcePlaceHint(url)?.name).filter(Boolean),
    ...instagramNames,
    ...extractPlaceCandidates(message, mapsUrl, candidatePages)
  ])];

  const addresses = [
    ...new Set(
      [
        ...sourceUrls.map(findSourceAddressHint),
        ...candidatePages.map((page) => page.address),
        extractAddress(message)
      ].filter(Boolean)
    )
  ];

  const areaHint = normalizeAreaHint(addresses[0]?.match(AREAS)?.[0] || extractAreaHint(message, pages));

  if (
    candidates.length === 0 &&
    addresses.length === 0
  ) {
    console.warn(`投稿 ${message.id} は店名や住所を特定できませんでした。`);

    return null;
  }

  let name = candidates[0] ||
    addresses[0];

  let position = mapsInformation?.position ||

    (
      mapsUrl &&
      extractCoordinatesFromUrl(mapsUrl)
    ) ||

    pages.find((page) => page.position)?.position ||

    null;

  let area = addresses[0]?.match(AREAS)?.[0] ||

    areaHint ||

    "多摩地域";

  if (!position) {
    let place = await findPlaceFromCandidates(candidates, addresses, areaHint);

    if (!place && instagramNames.length > 0) {
      place = await findInstagramPlace(instagramNames, areaHint);
    }

    if (!place) {
      console.warn(
        `投稿 ${message.id} は場所を特定できませんでした。 ` +
        `候補: ${candidates.join(" / ") || "なし"} / ` +
        `住所: ${addresses.join(" / ") || "なし"}`
      );

      return null;
    }

    name = place.name ||
      name;

    position = place.position;

    area = place.area;
  }

  console.log(`掲載: ${name} / ${area} / ${position.join(",")}`);

  return {
    id: message.id,
    name,
    type: classifySpot(message),
    genre: classifyGenre(
        message,
        name,
        ...pages.flatMap((page) => [ page.name || "", page.description || "" ] )),
    area,
    position,
    description: extractDescription(message, name),
    sourceUrl: sourceUrls[0] ||
      mapsUrl ||
      "",
    revision
  };
}

async function convertMessageToSpots(message, previousSpotsById) {
  const linkedSections = extractLinkedPlaceSections(message);

  if (linkedSections.length > 1) {
    console.log(`投稿 ${message.id} から${linkedSections.length}件の店舗別URLを確認します。`);

    const spots = [];

    for (let index = 0; index < linkedSections.length; index += 1) {
      const section = linkedSections[index];
      const id = `${message.id}-${index + 1}`;
      const sectionUrls = new Set(section.urls);
      const sectionMessage = {
        ...message,
        id,
        content: section.content,
        embeds: (message.embeds || []).filter((embed) => sectionUrls.has(embed.url))
      };

      try {
        const spot = await convertMessageToSpot(sectionMessage, previousSpotsById.get(id));

        if (spot) {
          spot.messageId = message.id;
          spot.sourceUrl = section.urls.find((url) => !isGoogleMapsUrl(url)) ||
            section.urls[0] || spot.sourceUrl;
          spots.push(spot);
        } else if (previousSpotsById.has(id)) {
          spots.push(previousSpotsById.get(id));
        }
      } catch (error) {
        console.warn(`投稿 ${message.id} の${index + 1}件目の処理に失敗しました: ${error.message}`);
        if (previousSpotsById.has(id)) spots.push(previousSpotsById.get(id));
      }
    }

    return spots;
  }

  const sections = extractMapSections(message);

  if (sections.length <= 1) {
    const spot = await convertMessageToSpot(message, previousSpotsById.get(message.id));

    return spot
      ? [spot]
      : [];
  }

  const revision = `${message.edited_timestamp || message.timestamp || ""}:v${DATA_VERSION}`;

  const spots = [];

  console.log(`投稿 ${message.id} から${sections.length}件のGoogleマップURLを確認します。`);

  for (
    let index = 0;
    index < sections.length;
    index += 1
  ) {
    const section = sections[index];

    const id = `${message.id}-${index + 1}`;

    const previousSpot = previousSpotsById.get(id);

    if (
      previousSpot &&
      previousSpot.revision === revision &&
      previousSpot.mapUrl === section.url
    ) {
      spots.push(previousSpot);

      continue;
    }

    const mapsInformation = await fetchGoogleMapsInformation(section.url);

    const mapsUrl = mapsInformation.url || section.url;

    const sectionMessage = {
      ...message,
      content: section.description,
      embeds: []
    };

    const candidates = extractPlaceCandidates(sectionMessage, mapsUrl, mapsInformation.name ? [mapsInformation] : []);

    const areaHint = normalizeAreaHint(extractAreaHint(sectionMessage, []));

    let name = mapsInformation.name ||
      candidates[0] ||
      `${areaHint || "多摩地域"}のおすすめスポット ${index + 1}`;

    if (!mapsInformation.name && isPlaceholderPlaceName(name)) {
      console.warn(
        `投稿 ${message.id} の${index + 1}件目は店名を取得できなかったため掲載しません。 ` +
        `仮タイトル: ${name} / URL: ${section.url}`
      );
      continue;
    }

    // GoogleマップHTML本文には画面中心など無関係な座標も多数ある。
    // リダイレクト後URLに明記された座標だけを信頼する。
    let position = extractCoordinatesFromUrl(mapsUrl);

    let area = areaHint ||
      "多摩地域";

    if (!position) {
      const addresses = mapsInformation.address
        ? [mapsInformation.address]
        : [];
      
      const place = await findPlaceFromCandidates(candidates, addresses, areaHint);

      if (!place) {
        console.warn(
          `投稿 ${message.id} の${index + 1}件目は場所を特定できませんでした。 ` +
          `候補: ${candidates.join(" / ") || "なし"} / ` +
          `URL: ${section.url}`
        );

        continue;
      }

      name = place.name ||
        name;

      position = place.position;

      area = place.area;
    }

    const spot = {
      id,
      messageId: message.id,
      name,
      type: classifySpot(sectionMessage),
      genre: classifyGenre(sectionMessage, name, mapsInformation.name || ""),
      area,
      position,
      description: section.description ||
        "コミュニティで紹介されたスポット。",
      sourceUrl: section.url,
      mapUrl: section.url,
      revision
    };

    console.log(`掲載: ${spot.name} / ${spot.area} / ${spot.position.join(",")}`);

    spots.push(spot);
  }

  return spots;
}

async function main() {
  const token = requiredEnvironmentVariable("DISCORD_BOT_TOKEN");

  const channelId = requiredEnvironmentVariable("DISCORD_CHANNEL_ID");

  const approverId = requiredEnvironmentVariable("DISCORD_APPROVER_USER_ID");

  const previous = new Map(( await readExistingSpots()).map((spot) => [ spot.id, spot ] ));

  const messages = await fetchChannelMessages(channelId, token);

  const selected = messages.filter((message) => !message.author?.bot && getMapReaction(message));

  const spots = [];

  console.log(
    `${messages.length}件の投稿から、` +
    `地図リアクション付きの${selected.length}件を確認します。`
  );

  for (const message of selected) {
    const reaction = getMapReaction(message);

    const approved = await wasApprovedByOwner(message, reaction, channelId, token, approverId);

    if (!approved) {
      console.log(`投稿 ${message.id} は投稿者本人または管理者の承認がありません。`);

      continue;
    }

    if (
      !message.content &&
      !(
        message.embeds || []
      ).length
    ) {
      console.warn(
        `投稿 ${message.id} の本文を取得できません。` +
        `MESSAGE CONTENT INTENTを確認してください。`
      );

      continue;
    }

    try {
      const messageSpots = await convertMessageToSpots(message, previous);

      if (messageSpots.length > 0) {
        spots.push(...messageSpots);
      } else {
        // リアクションが付いている投稿を、外部サイトの一時的な取得失敗で
        // 地図から消さない。リアクション自体が外れた投稿はselectedに入らず、
        // 従来どおり削除される。
        const previousMessageSpots = [...previous.values()].filter(
          (spot) =>
            spot.id === message.id ||
            spot.messageId === message.id ||
            String(spot.id).startsWith(`${message.id}-`)
        );

        const safePreviousSpots = previousMessageSpots.filter(
          (spot) =>
            normalizePlaceName(spot.name) &&
            spot.name !== "トップ" &&
            !isPlaceholderPlaceName(spot.name)
        );

        console.warn(
          `投稿 ${message.id} を再取得できなかったため、` +
          `既存の${safePreviousSpots.length}件を維持します。`
        );
        spots.push(...safePreviousSpots);
      }
    } catch (
      error
    ) {
      console.warn(`投稿 ${message.id} の処理に失敗しました: ${error.message}`);

      const previousMessageSpots = [
        ...previous.values()
      ].filter(
        (spot) =>
          spot.id === message.id ||
          spot.messageId === message.id ||
          String(spot.id).startsWith(`${message.id}-`)
      );

      spots.push(
        ...previousMessageSpots.filter(
          (spot) =>
            normalizePlaceName(spot.name) &&
            spot.name !== "トップ" &&
            !isPlaceholderPlaceName(spot.name)
        )
      );
    }
  }

  spots.sort(( left, right) => {
      const [
        leftMessageId,
        leftIndex = "0"
      ] = String(left.id).split("-");

      const [
        rightMessageId,
        rightIndex = "0"
      ] = String(right.id).split("-");

      if (
        leftMessageId !==
        rightMessageId
      ) {
        return (
          BigInt(leftMessageId) >
          BigInt(rightMessageId)
        )
          ? -1
          : 1;
      }

      return (
        Number(leftIndex) -
        Number(rightIndex)
      );
    }
  );

const publicSpots = spots
  .filter((spot) => !isPlaceholderPlaceName(spot.name))
  .map(({ description, ...spot }) => enrichSpotWithLocality(spot));

  await fs.writeFile(
    SPOTS_PATH,
    `${JSON.stringify(publicSpots, null, 2)}\n`,
    "utf8"
  );
  console.log(`${publicSpots.length}件の承認済みスポットを map/spots.json に保存しました。`);
}

if (require.main === module) {
  main().catch(
    (error) => {
      console.error(error.message);

      process.exitCode = 1;
    }
  );
}

module.exports = {
  classifyGenre,
  classifySpot,
  convertMessageToSpot,
  convertMessageToSpots,
  decodePage,
  extractAddress,
  extractAddressFromText,
  extractAreaHint,
  extractCoordinatesFromHtml,
  extractCoordinatesFromUrl,
  extractDescription,
  extractMapSections,
  extractLinkedPlaceSections,
  extractInstagramPlaceNames,
  extractPlaceCandidates,
  extractUrls,
  findAddressWithGsi,
  findInstagramPlace,
  findInstagramPlaceWithOverpass,
  findInstagramPlaceWithPhoton,
  findPlace,
  findPlaceFromCandidates,
  findSourceAddressHint,
  findSourcePlaceHint,
  getMapReaction,
  isGoogleMapsUrl,
  isInstagramUrl,
  matchesAreaHint,
  normalizeEmoji,
  normalizeAreaHint,
  normalizePlaceName,
  normalizeSearchName,
  namesMatch,
  parseCoordinatePair
};
