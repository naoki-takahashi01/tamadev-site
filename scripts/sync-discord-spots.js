"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const DISCORD_API = "https://discord.com/api/v10";

const NOMINATIM =
  "https://nominatim.openstreetmap.org/search";

const USER_AGENT =
  "tamadev-discord-spots/4.0 (+https://tamadev.jp/map/)";

const SPOTS_PATH = path.join(
  __dirname,
  "..",
  "map",
  "spots.json"
);

const MAX_MESSAGE_PAGES = 5;
const MAX_REACTION_PAGES = 5;
const MAP_REACTION = "🗺️";

const CITIES =
  "多摩市|八王子市|立川市|調布市|稲城市|府中市|日野市|町田市|国立市|国分寺市|小金井市|小平市|東村山市|東大和市|武蔵村山市|昭島市|福生市|羽村市|青梅市|あきる野市|西東京市|武蔵野市|三鷹市|狛江市|清瀬市|東久留米市";

const AREAS = new RegExp(
  `${CITIES}|聖蹟桜ヶ丘|多摩センター|南大沢|立川|調布|稲城|府中|永山|八王子`,
  "u"
);

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

function requiredEnvironmentVariable(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `${name} が未設定です。GitHub Secretsを確認してください。`
    );
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
      (_, code) => String.fromCodePoint(Number(code))
    )
    .replace(
      /&#x([\da-f]+);/gi,
      (_, code) => {
        return String.fromCodePoint(
          Number.parseInt(code, 16)
        );
      }
    );
}

function isValidPosition(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= 35.42 &&
    latitude <= 35.90 &&
    longitude >= 138.95 &&
    longitude <= 139.68
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
  const match = String(value || "").match(
    /(-?\d{1,2}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)/
  );

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
    decoded = decodeURIComponent(
      url.toString()
    );
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
    const position = parseCoordinatePair(
      url.searchParams.get(key)
    );

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
    values.push(
      embed.url || "",
      embed.description || ""
    );

    for (const field of embed.fields || []) {
      values.push(
        field.value || ""
      );
    }
  }

  const matches =
    values
      .join("\n")
      .match(/https?:\/\/[^\s<>]+/g) || [];

  return [
    ...new Set(
      matches.map(
        (url) =>
          url.replace(/[),。、]+$/, "")
      )
    )
  ];
}

function isGoogleMapsUrl(value) {
  try {
    const url = new URL(value);

    return (
      GOOGLE_HOSTS.has(url.hostname) &&
      (
        url.hostname === "maps.app.goo.gl" ||
        url.hostname === "maps.google.com" ||
        url.pathname.startsWith("/maps") ||
        url.pathname.startsWith("/place/")
      )
    );
  } catch {
    return false;
  }
}

function normalizePlaceName(value) {
  let name = cleanText(
    decodeHtmlEntities(value),
    160
  )
    .replace(
      /\s*[|｜]\s*(食べログ|Instagram|インスタグラム|note|Google マップ|Google Maps|ラーメンデータベース).*$/iu,
      ""
    )
    .replace(
      /\s*[-–—]\s*(食べログ|Instagram|インスタグラム|note|ラーメンデータベース).*$/iu,
      ""
    )
    .replace(
      /\s*[（(][@＠][^)）]+[)）].*$/u,
      ""
    )
    .replace(
      /\s*[@＠][a-zA-Z0-9_.]+.*$/u,
      ""
    )
    .replace(
      /\s*[（(][^()（）]*(?:カフェ|グルメ|うどん|そば|レストラン|食堂|パン|ラーメン)[^()（）]*[)）]\s*$/u,
      ""
    )
    .replace(
      /(?:クーポン|店舗情報|公式サイト|公式ホームページ|Instagram profile)\s*$/iu,
      ""
    )
    .replace(
      /^(?:東京都)?(?:多摩市|八王子市|立川市|調布市|稲城市|府中市)\s+(?:うどん|カフェ|ラーメン|グルメ)\s+/u,
      ""
    )
    .replace(
      /(?:を紹介します|を紹介する|をご紹介|のご紹介)\s*$/u,
      ""
    )
    .trim();

  const quoted = name.match(
    /^([^「」『』|｜]{1,30})[「『]([^」』]{1,50})[」』]/u
  );

  if (quoted) {
    name =
      /うどん|そば|カフェ|珈琲|書店|食堂|レストラン|パン/u.test(
        quoted[1]
      )
        ? `${quoted[1].trim()} ${quoted[2].trim()}`
        : quoted[2].trim();
  }

  return cleanText(
    name,
    80
  );
}

function extractAddressFromText(value) {
  const text = decodeHtmlEntities(
    String(value || "")
  )
    .replace(
      /<\/(?:p|div|li|td|th|address)>/gi,
      "\n"
    )
    .replace(
      /<br\s*\/?>/gi,
      "\n"
    )
    .replace(
      /<[^>]+>/g,
      " "
    )
    .replace(
      /[０-９]/g,
      (character) => {
        return String.fromCharCode(
          character.charCodeAt(0) - 0xfee0
        );
      }
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
      return cleanText(
        match[1],
        100
      ).replace(
        /[−ー]/g,
        "-"
      );
    }
  }

  return "";
}

function getMeta(html, names) {
  const wanted = new Set(
    names.map(
      (name) => name.toLowerCase()
    )
  );

  const tags =
    html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const key = tag
      .match(
        /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i
      )?.[1]
      ?.toLowerCase();

    if (!wanted.has(key)) {
      continue;
    }

    const content = tag.match(
      /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i
    );

    if (content) {
      return decodeHtmlEntities(
        content[1] || content[2]
      );
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

    if (
      Array.isArray(value)
    ) {
      value.forEach(
        (item) => visit(
          item,
          depth + 1
        )
      );

      return;
    }

    if (
      typeof value !== "object"
    ) {
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
      visit(
        value[key],
        depth + 1
      );
    }
  };

  const pattern =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(pattern)) {
    try {
      const json = JSON.parse(
        match[1]
          .trim()
          .replace(
            /^<!--|-->$/g,
            ""
          )
      );

      visit(json);

    } catch {
      continue;
    }
  }

  return results;
}

function structuredAddress(value) {
  if (
    typeof value === "string"
  ) {
    return (
      extractAddressFromText(value) ||
      cleanText(value, 100)
    );
  }

  if (
    !value ||
    typeof value !== "object"
  ) {
    return "";
  }

  const address = [
    value.addressRegion,
    value.addressLocality,
    value.streetAddress
  ]
    .filter(Boolean)
    .join("");

  return (
    extractAddressFromText(address) ||
    (
      /\d/.test(address)
        ? cleanText(address, 100)
        : ""
    )
  );
}

function extractCoordinatesFromHtml(html) {
  const latitude = getMeta(
    html,
    [
      "place:location:latitude",
      "latitude"
    ]
  );

  const longitude = getMeta(
    html,
    [
      "place:location:longitude",
      "longitude"
    ]
  );

  const metaPosition =
    latitude &&
    longitude &&
    makePosition(
      latitude,
      longitude
    );

  if (metaPosition) {
    return metaPosition;
  }

  const geoPosition = parseCoordinatePair(
    getMeta(
      html,
      [
        "geo.position",
        "icbm"
      ]
    )
  );

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
      ? makePosition(
          match[1],
          match[2]
        )
      : null;

    if (position) {
      return position;
    }
  }

  const mapPattern =
    /(?:src|href)\s*=\s*["']([^"']+(?:google\.com\/maps|google\.co\.jp\/maps)[^"']*)["']/gi;

  for (const match of html.matchAll(mapPattern)) {
    const position = extractCoordinatesFromUrl(
      decodeHtmlEntities(
        match[1]
      )
    );

    if (position) {
      return position;
    }
  }

  return null;
}

function decodePage(
  buffer,
  contentType
) {
  const bytes = new Uint8Array(
    buffer
  );

  const initial = new TextDecoder(
    "ascii"
  ).decode(
    bytes.slice(
      0,
      8192
    )
  );

  const charset =
    contentType.match(
      /charset\s*=\s*([^;\s]+)/i
    )?.[1] ||

    initial.match(
      /charset\s*=\s*["']?([\w-]+)/i
    )?.[1] ||

    initial.match(
      /encoding\s*=\s*["']([^"']+)/i
    )?.[1] ||

    "utf-8";

  let decoded;

  try {
    decoded = new TextDecoder(
      charset
    ).decode(
      bytes
    );

  } catch {
    decoded = new TextDecoder(
      "utf-8"
    ).decode(
      bytes
    );
  }

  const replacementCount = (
    decoded.match(
      /\uFFFD/g
    ) || []
  ).length;

  if (
    replacementCount > 5
  ) {
    for (const encoding of [
      "shift_jis",
      "euc-jp",
      "utf-8"
    ]) {
      try {
        const candidate = new TextDecoder(
          encoding
        ).decode(
          bytes
        );

        const errors = (
          candidate.match(
            /\uFFFD/g
          ) || []
        ).length;

        if (
          errors < replacementCount
        ) {
          console.log(
            `文字コードを補正: ${encoding}`
          );

          return candidate;
        }

      } catch {
        continue;
      }
    }
  }

  console.log(
    `文字コード: ${charset}`
  );

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
    console.log(
      `リンク先を確認: ${url}`
    );

    const response = await fetch(
      url,
      {
        redirect:
          "follow",

        headers: {
          "User-Agent":
            USER_AGENT,

          "Accept":
            "text/html,application/xhtml+xml",

          "Accept-Language":
            "ja,en;q=0.8"
        },

        signal:
          AbortSignal.timeout(
            15000
          )
      }
    );

    if (
      !response.ok
    ) {
      console.warn(
        `リンク先を取得できませんでした: ${response.status} / ${url}`
      );

      return null;
    }

    const contentType =
      response.headers.get(
        "content-type"
      ) || "";

    if (
      !/text\/html|application\/xhtml\+xml/i.test(
        contentType
      )
    ) {
      await response.body?.cancel();

      return null;
    }

    const html = decodePage(
      await response.arrayBuffer(),
      contentType
    ).slice(
      0,
      1200000
    );

    const entries = jsonLdEntries(
      html
    );

    const preferred = entries
      .map(
        (entry) => {
          const geo =
            entry.geo ||
            entry.location?.geo ||
            {};

          const position = makePosition(
            geo.latitude ??
            geo.lat,

            geo.longitude ??
            geo.lng ??
            geo.lon
          );

          const address = structuredAddress(
            entry.address ||
            entry.location?.address
          );

          const type = String(
            entry["@type"] || ""
          );

          const score =
            (
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
              /Restaurant|Store|LocalBusiness|Place|Cafe|FoodEstablishment/i.test(
                type
              )
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
      .sort(
        (
          left,
          right
        ) =>
          right.score -
          left.score
      )[0];

    const title =
      getMeta(
        html,
        [
          "og:title",
          "twitter:title"
        ]
      ) ||

      html.match(
        /<title\b[^>]*>([\s\S]*?)<\/title>/i
      )?.[1] ||

      "";

    const description = getMeta(
      html,
      [
        "description",
        "og:description",
        "twitter:description"
      ]
    );

    const address =
      preferred?.address ||

      extractAddressFromText(
        getMeta(
          html,
          [
            "og:street-address",
            "street-address",
            "streetaddress"
          ]
        )
      ) ||

      extractAddressFromText(
        description
      ) ||

      extractAddressFromText(
        html.slice(
          0,
          500000
        )
      );

    const information = {
      name:
        normalizePlaceName(
          preferred?.entry?.name ||
          title
        ),

      address,

      position:
        preferred?.position ||
        extractCoordinatesFromHtml(
          html
        ),

      description:
        cleanText(
          description,
          200
        )
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
    console.warn(
      `リンク先の取得に失敗しました: ${url} / ${error.message}`
    );

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

        ...(embed.fields || []).map(
          (field) =>
            field.value || ""
        )
      ]
    )
  ];

  for (const value of values) {
    const address = extractAddressFromText(
      value
    );

    if (address) {
      return address;
    }
  }

  return "";
}

function extractPlaceCandidates(
  message,
  mapsUrl,
  pages = []
) {
  const candidates = [];

  const add = (
    value
  ) => {
    const name =
      normalizePlaceName(
        value
      );

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
  ).match(
    /(?:場所|施設|会場|店名|名称|スポット)\s*[：:]\s*([^\n]+)/u
  );

  if (explicit) {
    add(
      explicit[1]
    );
  }

  if (mapsUrl) {
    try {
      const url = new URL(
        mapsUrl
      );

      const match = decodeURIComponent(
        url.pathname
      ).match(
        /\/place\/([^/]+)/
      );

      if (match) {
        add(
          match[1].replace(
            /\+/g,
            " "
          )
        );
      }

      for (const key of [
        "query",
        "q",
        "destination"
      ]) {
        const value =
          url.searchParams.get(
            key
          );

        if (
          value &&
          !parseCoordinatePair(value)
        ) {
          add(value);
        }
      }

    } catch {
      // GoogleマップのURLを解析できない場合は他の情報を使用。
    }
  }

  for (const page of pages) {
    add(
      page.name
    );
  }

  for (const embed of message.embeds || []) {
    add(
      embed.title
    );
  }

  const texts = [
    message.content || "",

    ...(message.embeds || []).flatMap(
      (embed) => [
        embed.title || "",
        embed.description || ""
      ]
    )
  ];

  for (const text of texts) {
    const quotedNames = text.matchAll(
      /[「『]([^」』]{1,60})[」』]/gu
    );

    for (const match of quotedNames) {
      add(
        match[1]
      );
    }
  }

  const lines = (
    message.content || ""
  )
    .split(
      /\r?\n/
    )
    .map(
      (line) =>
        cleanText(
          line,
          100
        )
    )
    .filter(
      Boolean
    );

  for (const line of lines) {
    if (
      line.length <= 40 &&
      !/おすすめです|美味しいです|おいしいです|ある.*です/u.test(
        line
      )
    ) {
      add(line);
    }
  }

  if (
    candidates.length === 0 &&
    lines.length > 0
  ) {
    add(
      lines[0]
    );
  }

  return candidates;
}

function extractAreaHint(
  message,
  pages = []
) {
  const text = [
    message.content || "",

    ...(message.embeds || []).flatMap(
      (embed) => [
        embed.title || "",
        embed.description || ""
      ]
    ),

    ...pages.flatMap(
      (page) => [
        page.address || "",
        page.description || "",
        page.name || ""
      ]
    )
  ].join(
    " "
  );

  return (
    text.match(
      AREAS
    )?.[0] ||

    ""
  );
}

function extractDescription(
  message,
  name
) {
  const lines = (
    message.content || ""
  )
    .split(
      /\r?\n/
    )
    .map(
      (line) =>
        cleanText(
          line,
          200
        )
    )
    .filter(
      (line) =>
        line &&
        line !== name &&
        !/^(場所|施設|会場|店名|名称|スポット|種類|分類)\s*[：:]/u.test(
          line
        )
    );

  if (lines.length > 0) {
    return cleanText(
      lines.join(" "),
      160
    );
  }

  const embed = (
    message.embeds || []
  ).find(
    (item) =>
      item.description ||
      item.title
  );

  return cleanText(
    embed?.description ||
    embed?.title ||
    "コミュニティで紹介されたスポット。",

    160
  );
}

function classifySpot(message) {
  const text = [
    message.content || "",

    ...(message.embeds || []).map(
      (embed) =>
        `${embed.title || ""} ${embed.description || ""}`
    )
  ].join(
    " "
  );

  if (
    /イベント|開催|お祭り|祭り|フェス|展示|ワークショップ|勉強会|体験会/u.test(
      text
    )
  ) {
    return "event";
  }

  if (
    /お店|飲食|カフェ|珈琲|コーヒー|パン屋|レストラン|ランチ|食堂|書店|うどん|カレー|ラーメン|酒店/u.test(
      text
    )
  ) {
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

async function requestDiscord(
  endpoint,
  token
) {
  for (
    let attempt = 0;
    attempt < 3;
    attempt += 1
  ) {
    const response = await fetch(
      DISCORD_API + endpoint,

      {
        headers: {
          Authorization:
            `Bot ${token}`,

          "User-Agent":
            USER_AGENT
        },

        signal:
          AbortSignal.timeout(
            15000
          )
      }
    );

    if (
      response.status === 429 &&
      attempt < 2
    ) {
      const body = await response
        .json()
        .catch(
          () => ({})
        );

      await wait(
        Math.max(
          Number(
            body.retry_after || 1
          ) * 1000,

          1000
        )
      );

      continue;
    }

    if (
      !response.ok
    ) {
      throw new Error(
        `Discord APIへの接続に失敗しました: ${response.status}`
      );
    }

    return response.json();
  }

  throw new Error(
    "Discord APIのリクエスト制限に達しました。"
  );
}

async function fetchChannelMessages(
  channelId,
  token
) {
  const messages = [];

  let before = "";

  for (
    let page = 0;
    page < MAX_MESSAGE_PAGES;
    page += 1
  ) {
    const parameters =
      new URLSearchParams({
        limit:
          "100"
      });

    if (before) {
      parameters.set(
        "before",
        before
      );
    }

    const batch = await requestDiscord(
      `/channels/${encodeURIComponent(channelId)}/messages?${parameters}`,

      token
    );

    if (
      !Array.isArray(batch)
    ) {
      throw new Error(
        "Discordの投稿一覧の形式が正しくありません。"
      );
    }

    messages.push(
      ...batch
    );

    if (
      batch.length < 100
    ) {
      break;
    }

    before =
      batch.at(-1).id;
  }

  return messages;
}

function normalizeEmoji(value) {
  return String(
    value || ""
  ).replace(
    /\uFE0F/g,
    ""
  );
}

function getMapReaction(message) {
  return (
    message.reactions || []
  ).find(
    (reaction) =>
      normalizeEmoji(
        reaction.emoji?.name
      ) ===
      normalizeEmoji(
        MAP_REACTION
      )
  );
}

async function wasApprovedByOwner(
  message,
  reaction,
  channelId,
  token,
  approverId
) {
  let after = "";

  for (
    let page = 0;
    page < MAX_REACTION_PAGES;
    page += 1
  ) {
    const parameters =
      new URLSearchParams({
        limit:
          "100"
      });

    if (after) {
      parameters.set(
        "after",
        after
      );
    }

    const users = await requestDiscord(
      `/channels/${encodeURIComponent(channelId)}` +
      `/messages/${encodeURIComponent(message.id)}` +
      `/reactions/${encodeURIComponent(reaction.emoji.name)}?${parameters}`,

      token
    );

    if (
      users.some(
        (user) =>
          user.id === approverId ||
          user.id === message.author.id
      )
    ) {
      return true;
    }

    if (
      users.length < 100
    ) {
      return false;
    }

    after =
      users.at(-1).id;
  }

  return false;
}

async function expandMapsUrl(url) {
  if (
    !url ||
    !isGoogleMapsUrl(url)
  ) {
    return url;
  }

  try {
    const response = await fetch(
      url,

      {
        redirect:
          "follow",

        headers: {
          "User-Agent":
            USER_AGENT
        },

        signal:
          AbortSignal.timeout(
            15000
          )
      }
    );

    await response.body?.cancel();

    return (
      response.url ||
      url
    );

  } catch {
    return url;
  }
}

async function findPlace(query) {
  const elapsed =
    Date.now() -
    previousGeocodingAt;

  if (
    elapsed < 1100
  ) {
    await wait(
      1100 - elapsed
    );
  }

  previousGeocodingAt =
    Date.now();

  const url = new URL(
    NOMINATIM
  );

  const parameters = {
    format:
      "jsonv2",

    q:
      query,

    countrycodes:
      "jp",

    addressdetails:
      "1",

    limit:
      "1",

    viewbox:
      "138.95,35.90,139.68,35.42",

    bounded:
      "1"
  };

  for (const [
    key,
    value
  ] of Object.entries(parameters)) {
    url.searchParams.set(
      key,
      value
    );
  }

  const response = await fetch(
    url,

    {
      headers: {
        "User-Agent":
          USER_AGENT,

        "Accept-Language":
          "ja"
      },

      signal:
        AbortSignal.timeout(
          15000
        )
    }
  );

  if (
    !response.ok
  ) {
    throw new Error(
      `場所の検索に失敗しました: ${response.status} / ${query}`
    );
  }

  const results =
    await response.json();

  const result =
    results[0];

  const position =
    result
      ? makePosition(
          result.lat,
          result.lon
        )
      : null;

  if (
    !position
  ) {
    return null;
  }

  const address =
    result.address || {};

  return {
    position,

    area:
      address.city ||
      address.town ||
      address.village ||
      address.county ||
      "多摩地域"
  };
}

async function findPlaceFromCandidates(
  candidates,
  addresses,
  areaHint
) {
  const searches = [];

  const add = (
    query,
    name
  ) => {
    const normalized = cleanText(
      query,
      120
    );

    if (
      normalized &&
      !searches.some(
        (item) =>
          item.query === normalized
      )
    ) {
      searches.push({
        query:
          normalized,

        name
      });
    }
  };

  for (const address of addresses) {
    add(
      address,

      candidates[0] ||
      address
    );
  }

  for (const candidate of candidates.slice(
    0,
    4
  )) {
    const simplified = candidate
      .replace(
        /\s*[-–—]\s*.+$/u,
        ""
      )
      .replace(
        /\s*[（(].*?[)）]\s*/gu,
        ""
      )
      .replace(
        /\s+(?:クーポン|公式|店舗情報).*$/u,
        ""
      )
      .trim();

    for (const name of new Set([
      candidate,
      simplified
    ])) {
      if (
        areaHint &&
        !name.includes(areaHint)
      ) {
        add(
          `${areaHint} ${name}`,
          name
        );
      }

      add(
        name,
        name
      );
    }
  }

  for (const search of searches.slice(
    0,
    10
  )) {
    console.log(
      `場所を検索: ${search.query}`
    );

    const result = await findPlace(
      search.query
    );

    if (result) {
      return {
        ...result,

        name:
          search.name
      };
    }
  }

  return null;
}

async function readExistingSpots() {
  try {
    const contents =
      await fs.readFile(
        SPOTS_PATH,
        "utf8"
      );

    const value = JSON.parse(
      contents
    );

    if (
      !Array.isArray(value)
    ) {
      throw new Error(
        "map/spots.json は配列である必要があります。"
      );
    }

    return value;

  } catch (
    error
  ) {
    if (
      error.code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  }
}

async function convertMessageToSpot(
  message,
  previousSpot
) {
  const revision =
    message.edited_timestamp ||
    message.timestamp ||
    "";

  if (
    previousSpot &&
    previousSpot.revision === revision
  ) {
    return previousSpot;
  }

  const urls = extractUrls(
    message
  );

  const originalMapsUrl =
    urls.find(
      isGoogleMapsUrl
    );

  const mapsUrl =
    originalMapsUrl
      ? await expandMapsUrl(
          originalMapsUrl
        )
      : "";

  const sourceUrls = urls
    .filter(
      (url) =>
        !isGoogleMapsUrl(url)
    )
    .slice(
      0,
      2
    );

  const pages = [];

  for (const url of sourceUrls) {
    const page =
      await fetchPageInformation(
        url
      );

    if (page) {
      pages.push(page);
    }
  }

  const candidates =
    extractPlaceCandidates(
      message,
      mapsUrl,
      pages
    );

  const addresses = [
    ...new Set(
      [
        ...pages.map(
          (page) =>
            page.address
        ),

        extractAddress(
          message
        )
      ].filter(
        Boolean
      )
    )
  ];

  const areaHint =
    extractAreaHint(
      message,
      pages
    );

  if (
    candidates.length === 0 &&
    addresses.length === 0
  ) {
    console.warn(
      `投稿 ${message.id} は店名や住所を特定できませんでした。`
    );

    return null;
  }

  let name =
    candidates[0] ||
    addresses[0];

  let position =
    (
      mapsUrl &&
      extractCoordinatesFromUrl(
        mapsUrl
      )
    ) ||

    pages.find(
      (page) =>
        page.position
    )?.position ||

    null;

  let area =
    previousSpot?.area ||

    addresses[0]?.match(
      AREAS
    )?.[0] ||

    areaHint ||

    "多摩地域";

  if (
    !position
  ) {
    const place =
      await findPlaceFromCandidates(
        candidates,
        addresses,
        areaHint
      );

    if (
      !place
    ) {
      console.warn(
        `投稿 ${message.id} は場所を特定できませんでした。 ` +
        `候補: ${candidates.join(" / ") || "なし"} / ` +
        `住所: ${addresses.join(" / ") || "なし"}`
      );

      return null;
    }

    name =
      place.name ||
      name;

    position =
      place.position;

    area =
      place.area;
  }

  console.log(
    `掲載: ${name} / ${area} / ${position.join(",")}`
  );

  return {
    id:
      message.id,

    name,

    type:
      classifySpot(
        message
      ),

    area,

    position,

    description:
      extractDescription(
        message,
        name
      ),

    sourceUrl:
      sourceUrls[0] ||
      mapsUrl ||
      "",

    revision
  };
}

async function main() {
  const token =
    requiredEnvironmentVariable(
      "DISCORD_BOT_TOKEN"
    );

  const channelId =
    requiredEnvironmentVariable(
      "DISCORD_CHANNEL_ID"
    );

  const approverId =
    requiredEnvironmentVariable(
      "DISCORD_APPROVER_USER_ID"
    );

  const previous = new Map(
    (
      await readExistingSpots()
    ).map(
      (spot) => [
        spot.id,
        spot
      ]
    )
  );

  const messages =
    await fetchChannelMessages(
      channelId,
      token
    );

  const selected = messages.filter(
    (message) =>
      !message.author?.bot &&
      getMapReaction(
        message
      )
  );

  const spots = [];

  console.log(
    `${messages.length}件の投稿から、` +
    `地図リアクション付きの${selected.length}件を確認します。`
  );

  for (const message of selected) {
    const approved =
      await wasApprovedByOwner(
        message,

        getMapReaction(
          message
        ),

        channelId,

        token,

        approverId
      );

    if (
      !approved
    ) {
      console.log(
        `投稿 ${message.id} は投稿者本人または管理者の承認がありません。`
      );

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
      const spot =
        await convertMessageToSpot(
          message,

          previous.get(
            message.id
          )
        );

      if (
        spot
      ) {
        spots.push(
          spot
        );
      }

    } catch (
      error
    ) {
      console.warn(
        `投稿 ${message.id} の処理に失敗しました: ${error.message}`
      );

      if (
        previous.has(
          message.id
        )
      ) {
        spots.push(
          previous.get(
            message.id
          )
        );
      }
    }
  }

  spots.sort(
    (
      left,
      right
    ) => {
      if (
        left.id === right.id
      ) {
        return 0;
      }

      return BigInt(
        left.id
      ) > BigInt(
        right.id
      )
        ? -1
        : 1;
    }
  );

  await fs.writeFile(
    SPOTS_PATH,

    `${JSON.stringify(
      spots,
      null,
      2
    )}\n`,

    "utf8"
  );

  console.log(
    `${spots.length}件の承認済みスポットを map/spots.json に保存しました。`
  );
}

if (
  require.main === module
) {
  main().catch(
    (error) => {
      console.error(
        error.message
      );

      process.exitCode = 1;
    }
  );
}

module.exports = {
  classifySpot,
  decodePage,
  extractAddress,
  extractAddressFromText,
  extractAreaHint,
  extractCoordinatesFromHtml,
  extractCoordinatesFromUrl,
  extractDescription,
  extractPlaceCandidates,
  extractUrls,
  getMapReaction,
  isGoogleMapsUrl,
  normalizeEmoji,
  normalizePlaceName,
  parseCoordinatePair
};
