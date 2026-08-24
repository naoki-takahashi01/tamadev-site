"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const DISCORD_API_BASE = "https://discord.com/api/v10";

const MAP_REACTION = "🗺️";

const MAX_MESSAGE_PAGES = 5;
const MAX_REACTION_PAGES = 5;

const NOMINATIM_BASE =
  "https://nominatim.openstreetmap.org/search";

const USER_AGENT =
  "tamadev-discord-spots/3.0 (+https://tamadev.jp/map/)";

const SPOTS_PATH = path.join(
  __dirname,
  "..",
  "map",
  "spots.json"
);

const GOOGLE_MAPS_HOSTS = new Set([
  "maps.app.goo.gl",
  "goo.gl",
  "google.com",
  "www.google.com",
  "maps.google.com",
  "google.co.jp",
  "www.google.co.jp"
]);

const TAMA_AREA_PATTERN =
  /多摩市|八王子市|立川市|調布市|稲城市|府中市|日野市|町田市|国立市|国分寺市|小金井市|小平市|東村山市|東大和市|武蔵村山市|昭島市|福生市|羽村市|青梅市|あきる野市|西東京市|武蔵野市|三鷹市|狛江市|清瀬市|東久留米市|聖蹟桜ヶ丘|多摩センター|南大沢|立川|調布|稲城|府中|永山|八王子/u;

let previousGeocodingAt = 0;

function requiredEnvironmentVariable(name) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(
      `${name} が未設定です。GitHub Secretsを確認してください。`
    );
  }

  return value.trim();
}

function normalizeEmoji(value) {
  return String(value || "")
    .replace(/\uFE0F/g, "");
}

function cleanText(value, maximumLength = 160) {
  return String(value || "")
    .replace(/https?:\/\/[^\s<>]+/g, "")
    .replace(/<@!?\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
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
      (_, code) => {
        const value = Number(code);

        return (
          Number.isInteger(value) &&
          value >= 0 &&
          value <= 0x10ffff
        )
          ? String.fromCodePoint(value)
          : "";
      }
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, code) => {
        const value = Number.parseInt(
          code,
          16
        );

        return (
          Number.isInteger(value) &&
          value >= 0 &&
          value <= 0x10ffff
        )
          ? String.fromCodePoint(value)
          : "";
      }
    );
}

function stripHtml(value) {
  return cleanText(
    decodeHtmlEntities(
      String(value || "")
        .replace(
          /<script\b[^>]*>[\s\S]*?<\/script>/gi,
          " "
        )
        .replace(
          /<style\b[^>]*>[\s\S]*?<\/style>/gi,
          " "
        )
        .replace(
          /<br\s*\/?>/gi,
          " "
        )
        .replace(
          /<[^>]+>/g,
          " "
        )
    ),
    1200
  );
}

function isValidPosition(
  latitude,
  longitude
) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

function isWithinTamaRegion(
  latitude,
  longitude
) {
  return (
    isValidPosition(
      latitude,
      longitude
    ) &&
    latitude >= 35.42 &&
    latitude <= 35.90 &&
    longitude >= 138.95 &&
    longitude <= 139.68
  );
}

function parseCoordinatePair(value) {
  const match = String(value || "").match(
    /(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/
  );

  if (!match) {
    return null;
  }

  const latitude = Number(
    match[1]
  );

  const longitude = Number(
    match[2]
  );

  return isValidPosition(
    latitude,
    longitude
  )
    ? [
        latitude,
        longitude
      ]
    : null;
}

function extractCoordinatesFromUrl(urlString) {
  let parsedUrl;

  try {
    parsedUrl = new URL(
      urlString
    );
  } catch {
    return null;
  }

  let decodedUrl;

  try {
    decodedUrl = decodeURIComponent(
      parsedUrl.toString()
    );
  } catch {
    decodedUrl = parsedUrl.toString();
  }

  const atCoordinates = decodedUrl.match(
    /@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/
  );

  if (atCoordinates) {
    return parseCoordinatePair(
      `${atCoordinates[1]},${atCoordinates[2]}`
    );
  }

  const placeCoordinates = decodedUrl.match(
    /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/
  );

  if (placeCoordinates) {
    return parseCoordinatePair(
      `${placeCoordinates[1]},${placeCoordinates[2]}`
    );
  }

  for (const key of [
    "q",
    "query",
    "destination",
    "ll",
    "center"
  ]) {
    const position = parseCoordinatePair(
      parsedUrl.searchParams.get(
        key
      )
    );

    if (position) {
      return position;
    }
  }

  return parseCoordinatePair(
    parsedUrl.pathname
  );
}

function extractUrls(message) {
  const texts = [
    message.content || ""
  ];

  for (const embed of message.embeds || []) {
    if (embed.url) {
      texts.push(
        embed.url
      );
    }

    if (embed.description) {
      texts.push(
        embed.description
      );
    }

    for (const field of embed.fields || []) {
      if (field.value) {
        texts.push(
          field.value
        );
      }
    }
  }

  const matches =
    texts
      .join("\n")
      .match(
        /https?:\/\/[^\s<>]+/g
      ) || [];

  return [
    ...new Set(
      matches.map(
        (url) =>
          url.replace(
            /[),。、]+$/,
            ""
          )
      )
    )
  ];
}

function isGoogleMapsUrl(urlString) {
  try {
    const url = new URL(
      urlString
    );

    return (
      GOOGLE_MAPS_HOSTS.has(
        url.hostname
      ) &&
      (
        url.hostname === "maps.app.goo.gl" ||
        url.hostname === "maps.google.com" ||
        url.pathname.startsWith(
          "/maps"
        ) ||
        url.pathname.startsWith(
          "/place/"
        )
      )
    );
  } catch {
    return false;
  }
}

function extractPlaceNameFromMapsUrl(
  mapsUrl
) {
  if (!mapsUrl) {
    return "";
  }

  try {
    const parsedUrl = new URL(
      mapsUrl
    );

    const placePath = decodeURIComponent(
      parsedUrl.pathname
    ).match(
      /\/place\/([^/]+)/
    );

    if (
      placePath &&
      !parseCoordinatePair(
        placePath[1]
      )
    ) {
      return cleanText(
        placePath[1].replace(
          /\+/g,
          " "
        ),
        80
      );
    }

    for (const key of [
      "query",
      "q",
      "destination"
    ]) {
      const value =
        parsedUrl.searchParams.get(
          key
        );

      if (
        value &&
        !parseCoordinatePair(
          value
        )
      ) {
        return cleanText(
          value,
          80
        );
      }
    }
  } catch {
    return "";
  }

  return "";
}

function normalizePlaceName(value) {
  let title = cleanText(
    decodeHtmlEntities(
      value
    ),
    160
  );

  if (!title) {
    return "";
  }

  title = title
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

  const quotedTitle = title.match(
    /^([^「」『』|｜]{1,30})[「『]([^」』]{1,50})[」』]/u
  );

  if (quotedTitle) {
    const prefix = cleanText(
      quotedTitle[1],
      40
    );

    const name = cleanText(
      quotedTitle[2],
      50
    );

    if (
      /うどん|そば|カフェ|珈琲|書店|食堂|レストラン|パン/u.test(
        prefix
      )
    ) {
      return cleanText(
        `${prefix} ${name}`,
        80
      );
    }

    return name;
  }

  return cleanText(
    title,
    80
  );
}

function extractQuotedNames(message) {
  const texts = [
    message.content || "",

    ...(message.embeds || []).flatMap(
      (embed) => [
        embed.title || "",
        embed.description || ""
      ]
    )
  ];

  return [
    ...new Set(
      texts.flatMap(
        (text) =>
          [...text.matchAll(
            /[「『]([^」』]{1,60})[」』]/gu
          )]
            .map(
              (match) =>
                cleanText(
                  match[1],
                  80
                )
            )
            .filter(
              Boolean
            )
      )
    )
  ];
}

function extractPlaceCandidates(
  message,
  mapsUrl,
  pageInformation = []
) {
  const candidates = [];

  const addCandidate = (
    value
  ) => {
    const normalized =
      normalizePlaceName(
        value
      );

    if (
      normalized &&
      !candidates.includes(
        normalized
      )
    ) {
      candidates.push(
        normalized
      );
    }
  };

  const content =
    message.content || "";

  const explicitName = content.match(
    /(?:場所|施設|会場|店名|名称|スポット)\s*[：:]\s*([^\n]+)/u
  );

  if (explicitName) {
    addCandidate(
      explicitName[1]
    );
  }

  addCandidate(
    extractPlaceNameFromMapsUrl(
      mapsUrl
    )
  );

  for (
    const information
    of pageInformation
  ) {
    if (
      information.name
    ) {
      addCandidate(
        information.name
      );
    }
  }

  for (
    const embed
    of message.embeds || []
  ) {
    addCandidate(
      embed.title
    );
  }

  for (
    const quotedName
    of extractQuotedNames(
      message
    )
  ) {
    addCandidate(
      quotedName
    );
  }

  const placeInSentence = content.match(
    /(?:ある|あるのは|あるのが|お店は|店は|施設は)\s*[「『]?([A-Za-z][A-Za-z0-9 .&'-]{2,40}|[一-龠ぁ-んァ-ヶー]{2,30})[」』]?(?:という|です|で、|。)/u
  );

  if (
    placeInSentence
  ) {
    addCandidate(
      placeInSentence[1]
    );
  }

  const contentLines = content
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
    )
    .filter(
      (line) =>
        !/^(種類|分類|説明|紹介|日時|開催日)\s*[：:]/u.test(
          line
        )
    );

  for (
    const line
    of contentLines
  ) {
    if (
      line.length <= 40 &&
      !/おすすめです|美味しいです|おいしいです|ある.*です/u.test(
        line
      )
    ) {
      addCandidate(
        line
      );
    }
  }

  if (
    candidates.length === 0 &&
    contentLines.length > 0
  ) {
    addCandidate(
      contentLines[0]
    );
  }

  return candidates;
}

function extractPlaceName(
  message,
  mapsUrl
) {
  return (
    extractPlaceCandidates(
      message,
      mapsUrl
    )[0] || ""
  );
}

function extractAddressFromText(value) {
  const text = decodeHtmlEntities(
    String(
      value || ""
    )
  )
    .replace(
      /<br\s*\/?>/gi,
      " "
    )
    .replace(
      /<[^>]+>/g,
      " "
    )
    .replace(
      /[ \t]+/g,
      " "
    );

  const addressMatch = text.match(
    /(?:〒\s*\d{3}[-ー]\d{4}\s*)?(?:東京都)?(?:多摩市|八王子市|立川市|調布市|稲城市|府中市|日野市|町田市|国立市|国分寺市|小金井市|小平市|東村山市|東大和市|武蔵村山市|昭島市|福生市|羽村市|青梅市|あきる野市|西東京市|武蔵野市|三鷹市|狛江市|清瀬市|東久留米市)(?:[一-龠ぁ-んァ-ヶーA-Za-z0-9０-９丁目番地号\-−ー\s]{2,60})/u
  );

  if (
    !addressMatch
  ) {
    return "";
  }

  let address = addressMatch[0]
    .replace(
      /^〒\s*\d{3}[-ー]\d{4}\s*/u,
      ""
    )
    .replace(
      /\s+(?:TEL|電話|営業時間|定休日|アクセス|地図|店舗情報).*$/iu,
      ""
    )
    .trim();

  const numberedAddress = address.match(
    /^(.{2,50}?(?:\d|[０-９])(?:丁目|番地|番|号|[-−ー]\d|[-−ー][０-９])?.{0,20})/u
  );

  if (
    numberedAddress
  ) {
    address =
      numberedAddress[1].trim();
  }

  return cleanText(
    address,
    100
  );
}

function extractAddress(message) {
  const texts = [
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

  for (
    const text
    of texts
  ) {
    const address =
      extractAddressFromText(
        text
      );

    if (
      address
    ) {
      return address;
    }
  }

  return "";
}

function extractAreaHint(
  message,
  pageInformation = []
) {
  const texts = [
    message.content || "",

    ...(message.embeds || []).flatMap(
      (embed) => [
        embed.title || "",
        embed.description || ""
      ]
    ),

    ...pageInformation.flatMap(
      (information) => [
        information.address || "",
        information.description || "",
        information.name || ""
      ]
    )
  ].join(
    " "
  );

  const match = texts.match(
    TAMA_AREA_PATTERN
  );

  return match
    ? match[0]
    : "";
}

function extractDescription(
  message,
  placeName
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
      Boolean
    )
    .filter(
      (line) =>
        line !== placeName
    )
    .filter(
      (line) =>
        !/^(場所|施設|会場|店名|名称|スポット|種類|分類)\s*[：:]/u.test(
          line
        )
    );

  if (
    lines.length > 0
  ) {
    return cleanText(
      lines.join(
        " "
      ),
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
    embed
      ? (
          embed.description ||
          embed.title
        )
      : "コミュニティで紹介されたスポット。",

    160
  );
}

function classifySpot(
  message
) {
  const text = [
    message.content || "",

    ...(message.embeds || []).map(
      (embed) =>
        [
          embed.title,
          embed.description
        ]
          .filter(
            Boolean
          )
          .join(
            " "
          )
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

function wait(
  milliseconds
) {
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
    const response =
      await fetch(
        DISCORD_API_BASE + endpoint,

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
      const body =
        await response.json()
          .catch(
            () => ({})
          );

      const retryAfter = Number(
        body.retry_after || 1
      );

      await wait(
        Math.max(
          retryAfter * 1000,
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

    if (
      before
    ) {
      parameters.set(
        "before",
        before
      );
    }

    const endpoint =
      `/channels/${encodeURIComponent(channelId)}` +
      `/messages?${parameters.toString()}`;

    const batch =
      await requestDiscord(
        endpoint,
        token
      );

    if (
      !Array.isArray(
        batch
      )
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
      batch[
        batch.length - 1
      ].id;
  }

  return messages;
}

function getMapReaction(
  message
) {
  return (
    message.reactions || []
  ).find(
    (reaction) =>
      normalizeEmoji(
        reaction.emoji &&
        reaction.emoji.name
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

  const emoji =
    encodeURIComponent(
      reaction.emoji.name
    );

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

    if (
      after
    ) {
      parameters.set(
        "after",
        after
      );
    }

    const endpoint =
      `/channels/${encodeURIComponent(channelId)}` +
      `/messages/${encodeURIComponent(message.id)}` +
      `/reactions/${emoji}?${parameters.toString()}`;

    const users =
      await requestDiscord(
        endpoint,
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
      users[
        users.length - 1
      ].id;
  }

  return false;
}

async function expandMapsUrl(
  url
) {
  if (
    !url ||
    !isGoogleMapsUrl(
      url
    )
  ) {
    return url;
  }

  try {
    const response =
      await fetch(
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

function extractTagAttribute(
  tag,
  attributeName
) {
  const pattern =
    new RegExp(
      `\\b${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,

      "i"
    );

  const match =
    String(
      tag || ""
    ).match(
      pattern
    );

  if (
    !match
  ) {
    return "";
  }

  return decodeHtmlEntities(
    match[1] ||
    match[2] ||
    match[3] ||
    ""
  );
}

function extractMetaContent(
  html,
  keys
) {
  const tags =
    html.match(
      /<meta\b[^>]*>/gi
    ) || [];

  const normalizedKeys =
    new Set(
      keys.map(
        (key) =>
          key.toLowerCase()
      )
    );

  for (
    const tag
    of tags
  ) {
    const property =
      extractTagAttribute(
        tag,
        "property"
      ).toLowerCase();

    const name =
      extractTagAttribute(
        tag,
        "name"
      ).toLowerCase();

    const itemprop =
      extractTagAttribute(
        tag,
        "itemprop"
      ).toLowerCase();

    if (
      normalizedKeys.has(
        property
      ) ||
      normalizedKeys.has(
        name
      ) ||
      normalizedKeys.has(
        itemprop
      )
    ) {
      const content =
        extractTagAttribute(
          tag,
          "content"
        );

      if (
        content
      ) {
        return content;
      }
    }
  }

  return "";
}

function extractHtmlTitle(
  html
) {
  const match =
    html.match(
      /<title\b[^>]*>([\s\S]*?)<\/title>/i
    );

  if (
    !match
  ) {
    return "";
  }

  return stripHtml(
    match[1]
  );
}

function extractJsonLdBlocks(
  html
) {
  const blocks = [];

  const pattern =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (
    const match
    of html.matchAll(
      pattern
    )
  ) {
    const raw =
      match[1]
        .trim()
        .replace(
          /^<!--/,
          ""
        )
        .replace(
          /-->$/,
          ""
        )
        .trim();

    try {
      blocks.push(
        JSON.parse(
          raw
        )
      );
    } catch {
      continue;
    }
  }

  return blocks;
}

function flattenJsonLd(
  value,
  results = [],
  depth = 0
) {
  if (
    !value ||
    depth > 8
  ) {
    return results;
  }

  if (
    Array.isArray(
      value
    )
  ) {
    for (
      const item
      of value
    ) {
      flattenJsonLd(
        item,
        results,
        depth + 1
      );
    }

    return results;
  }

  if (
    typeof value !== "object"
  ) {
    return results;
  }

  results.push(
    value
  );

  for (
    const key
    of [
      "@graph",
      "mainEntity",
      "itemListElement",
      "item",
      "location",
      "subjectOf",
      "about"
    ]
  ) {
    if (
      value[key]
    ) {
      flattenJsonLd(
        value[key],
        results,
        depth + 1
      );
    }
  }

  return results;
}

function formatStructuredAddress(
  address
) {
  if (
    !address
  ) {
    return "";
  }

  if (
    typeof address === "string"
  ) {
    return cleanText(
      address,
      100
    );
  }

  if (
    typeof address !== "object"
  ) {
    return "";
  }

  return cleanText(
    [
      address.addressRegion,
      address.addressLocality,
      address.streetAddress
    ]
      .filter(
        Boolean
      )
      .join(
        ""
      ),
    100
  );
}

function extractStructuredPosition(
  value
) {
  if (
    !value ||
    typeof value !== "object"
  ) {
    return null;
  }

  const geo =
    value.geo ||
    value.location?.geo ||
    value;

  const latitude =
    Number(
      geo.latitude ??
      geo.lat
    );

  const longitude =
    Number(
      geo.longitude ??
      geo.lon ??
      geo.lng
    );

  if (
    isWithinTamaRegion(
      latitude,
      longitude
    )
  ) {
    return [
      latitude,
      longitude
    ];
  }

  return null;
}

function findStructuredPlace(
  html
) {
  const entries =
    extractJsonLdBlocks(
      html
    ).flatMap(
      (block) =>
        flattenJsonLd(
          block
        )
    );

  const placeTypes =
    /Restaurant|FoodEstablishment|CafeOrCoffeeShop|Store|LocalBusiness|Place|TouristAttraction|Organization|Event|Bakery|BarOrPub/u;

  const scoredEntries =
    entries
      .map(
        (entry) => {
          const type =
            Array.isArray(
              entry["@type"]
            )
              ? entry["@type"].join(
                  " "
                )
              : String(
                  entry["@type"] || ""
                );

          const position =
            extractStructuredPosition(
              entry
            );

          const address =
            formatStructuredAddress(
              entry.address ||
              entry.location?.address
            );

          let score = 0;

          if (
            placeTypes.test(
              type
            )
          ) {
            score += 5;
          }

          if (
            position
          ) {
            score += 4;
          }

          if (
            address
          ) {
            score += 3;
          }

          if (
            entry.name
          ) {
            score += 1;
          }

          return {
            entry,
            score,
            position,
            address
          };
        }
      )
      .sort(
        (left, right) =>
          right.score -
          left.score
      );

  const best =
    scoredEntries[0];

  if (
    !best ||
    best.score === 0
  ) {
    return {
      name:
        "",

      address:
        "",

      position:
        null
    };
  }

  return {
    name:
      normalizePlaceName(
        best.entry.name ||
        best.entry.headline ||
        ""
      ),

    address:
      best.address,

    position:
      best.position
  };
}

function extractCoordinatesFromHtml(
  html
) {
  const latitudeMeta =
    extractMetaContent(
      html,
      [
        "place:location:latitude",
        "geo.position",
        "icbm",
        "latitude"
      ]
    );

  const longitudeMeta =
    extractMetaContent(
      html,
      [
        "place:location:longitude",
        "longitude"
      ]
    );

  if (
    latitudeMeta &&
    longitudeMeta
  ) {
    const latitude =
      Number(
        latitudeMeta
      );

    const longitude =
      Number(
        longitudeMeta
      );

    if (
      isWithinTamaRegion(
        latitude,
        longitude
      )
    ) {
      return [
        latitude,
        longitude
      ];
    }
  }

  if (
    latitudeMeta
  ) {
    const position =
      parseCoordinatePair(
        latitudeMeta.replace(
          ";",
          ","
        )
      );

    if (
      position &&
      isWithinTamaRegion(
        position[0],
        position[1]
      )
    ) {
      return position;
    }
  }

  const patterns = [
    /["']latitude["']\s*:\s*["']?(-?\d{1,2}(?:\.\d+)?)["']?[\s\S]{0,120}?["']longitude["']\s*:\s*["']?(-?\d{1,3}(?:\.\d+)?)/i,

    /["']lat["']\s*:\s*["']?(-?\d{1,2}(?:\.\d+)?)["']?[\s\S]{0,100}?["'](?:lng|lon)["']\s*:\s*["']?(-?\d{1,3}(?:\.\d+)?)/i,

    /@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/,

    /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/
  ];

  for (
    const pattern
    of patterns
  ) {
    const match =
      html.match(
        pattern
      );

    if (
      !match
    ) {
      continue;
    }

    const latitude =
      Number(
        match[1]
      );

    const longitude =
      Number(
        match[2]
      );

    if (
      isWithinTamaRegion(
        latitude,
        longitude
      )
    ) {
      return [
        latitude,
        longitude
      ];
    }
  }

  return null;
}

function extractAddressFromHtml(
  html
) {
  const structured =
    findStructuredPlace(
      html
    );

  if (
    structured.address
  ) {
    return structured.address;
  }

  const metaCandidates = [
    extractMetaContent(
      html,
      [
        "og:street-address",
        "street-address",
        "streetaddress"
      ]
    ),

    extractMetaContent(
      html,
      [
        "description",
        "og:description",
        "twitter:description"
      ]
    )
  ];

  for (
    const candidate
    of metaCandidates
  ) {
    const address =
      extractAddressFromText(
        candidate
      );

    if (
      address
    ) {
      return address;
    }
  }

  const labeledPatterns = [
    /(?:住所|所在地|店舗住所|アクセス)\s*[:：]?\s*(?:<\/[^>]+>\s*<[^>]+>)*([^<\n]{8,120})/giu,

    /itemprop\s*=\s*["']streetAddress["'][^>]*>([\s\S]{3,150}?)<\//giu,

    /class\s*=\s*["'][^"']*(?:address|rstinfo-table__address)[^"']*["'][^>]*>([\s\S]{3,250}?)<\//giu
  ];

  for (
    const pattern
    of labeledPatterns
  ) {
    for (
      const match
      of html.matchAll(
        pattern
      )
    ) {
      const address =
        extractAddressFromText(
          match[1]
        );

      if (
        address
      ) {
        return address;
      }
    }
  }

  return extractAddressFromText(
    html.slice(
      0,
      400000
    )
  );
}

async function fetchPageInformation(
  sourceUrl
) {
  if (
    !sourceUrl ||
    isGoogleMapsUrl(
      sourceUrl
    )
  ) {
    return null;
  }

  let parsedUrl;

  try {
    parsedUrl =
      new URL(
        sourceUrl
      );
  } catch {
    return null;
  }

  if (
    ![
      "http:",
      "https:"
    ].includes(
      parsedUrl.protocol
    )
  ) {
    return null;
  }

  try {
    console.log(
      `リンク先を確認: ${sourceUrl}`
    );

    const response =
      await fetch(
        sourceUrl,

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
        `リンク先を取得できませんでした: ${response.status} / ${sourceUrl}`
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

    const html =
      (
        await response.text()
      ).slice(
        0,
        1200000
      );

    const structured =
      findStructuredPlace(
        html
      );

    const metaTitle =
      extractMetaContent(
        html,
        [
          "og:title",
          "twitter:title"
        ]
      );

    const description =
      extractMetaContent(
        html,
        [
          "og:description",
          "description",
          "twitter:description"
        ]
      );

    const information = {
      url:
        response.url ||
        sourceUrl,

      name:
        structured.name ||
        normalizePlaceName(
          metaTitle ||
          extractHtmlTitle(
            html
          )
        ),

      address:
        structured.address ||
        extractAddressFromHtml(
          html
        ),

      position:
        structured.position ||
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
      `リンク先の取得に失敗しました: ${sourceUrl} / ${error.message}`
    );

    return null;
  }
}

async function findPlace(
  query
) {
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

  const searchUrl =
    new URL(
      NOMINATIM_BASE
    );

  searchUrl.searchParams.set(
    "format",
    "jsonv2"
  );

  searchUrl.searchParams.set(
    "q",
    query
  );

  searchUrl.searchParams.set(
    "countrycodes",
    "jp"
  );

  searchUrl.searchParams.set(
    "addressdetails",
    "1"
  );

  searchUrl.searchParams.set(
    "limit",
    "1"
  );

  searchUrl.searchParams.set(
    "viewbox",
    "138.95,35.90,139.68,35.42"
  );

  searchUrl.searchParams.set(
    "bounded",
    "1"
  );

  const response =
    await fetch(
      searchUrl,

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

  if (
    !Array.isArray(
      results
    ) ||
    results.length === 0
  ) {
    return null;
  }

  const result =
    results[0];

  const latitude =
    Number(
      result.lat
    );

  const longitude =
    Number(
      result.lon
    );

  if (
    !isWithinTamaRegion(
      latitude,
      longitude
    )
  ) {
    return null;
  }

  const address =
    result.address || {};

  return {
    position: [
      latitude,
      longitude
    ],

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

  const addSearch = (
    query,
    displayName
  ) => {
    const normalized =
      cleanText(
        query,
        120
      );

    if (
      normalized &&
      !searches.some(
        (search) =>
          search.query === normalized
      )
    ) {
      searches.push({
        query:
          normalized,

        displayName:
          displayName ||
          normalized
      });
    }
  };

  for (
    const address
    of addresses
  ) {
    if (
      address
    ) {
      addSearch(
        address,
        candidates[0] ||
        address
      );
    }
  }

  for (
    const candidate
    of candidates.slice(
      0,
      4
    )
  ) {
    if (
      areaHint &&
      !candidate.includes(
        areaHint
      )
    ) {
      addSearch(
        `${areaHint} ${candidate}`,
        candidate
      );
    }

    addSearch(
      candidate,
      candidate
    );

    const simplifiedCandidate =
      candidate
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

    if (
      simplifiedCandidate &&
      simplifiedCandidate !== candidate
    ) {
      if (
        areaHint
      ) {
        addSearch(
          `${areaHint} ${simplifiedCandidate}`,
          simplifiedCandidate
        );
      }

      addSearch(
        simplifiedCandidate,
        simplifiedCandidate
      );
    }
  }

  for (
    const search
    of searches.slice(
      0,
      10
    )
  ) {
    console.log(
      `場所を検索: ${search.query}`
    );

    const place =
      await findPlace(
        search.query
      );

    if (
      place
    ) {
      return {
        ...place,

        name:
          search.displayName
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

    const spots =
      JSON.parse(
        contents
      );

    if (
      !Array.isArray(
        spots
      )
    ) {
      throw new Error(
        "map/spots.json は配列である必要があります。"
      );
    }

    return spots;

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

function areaFromAddress(
  address
) {
  const match =
    String(
      address || ""
    ).match(
      TAMA_AREA_PATTERN
    );

  return match
    ? match[0]
    : "";
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

  const urls =
    extractUrls(
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

  const sourceUrls =
    urls
      .filter(
        (url) =>
          !isGoogleMapsUrl(
            url
          )
      )
      .slice(
        0,
        2
      );

  const pageInformation = [];

  for (
    const sourceUrl
    of sourceUrls
  ) {
    const information =
      await fetchPageInformation(
        sourceUrl
      );

    if (
      information
    ) {
      pageInformation.push(
        information
      );
    }
  }

  const candidates =
    extractPlaceCandidates(
      message,
      mapsUrl,
      pageInformation
    );

  const addresses = [
    ...new Set(
      [
        ...pageInformation.map(
          (information) =>
            information.address
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
      pageInformation
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
    mapsUrl
      ? extractCoordinatesFromUrl(
          mapsUrl
        )
      : null;

  if (
    position &&
    !isWithinTamaRegion(
      position[0],
      position[1]
    )
  ) {
    position =
      null;
  }

  if (
    !position
  ) {
    position =
      pageInformation.find(
        (information) =>
          information.position
      )?.position ||
      null;
  }

  let area =
    previousSpot?.area ||
    areaFromAddress(
      addresses[0]
    ) ||
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

  const sourceUrl =
    sourceUrls[0] ||
    mapsUrl ||
    "";

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

    sourceUrl,

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

  const previousSpots =
    await readExistingSpots();

  const previousSpotsById =
    new Map(
      previousSpots.map(
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

  const selectedMessages =
    messages.filter(
      (message) =>
        !message.author?.bot &&
        getMapReaction(
          message
        )
    );

  const approvedSpots = [];

  console.log(
    `${messages.length}件の投稿から、` +
    `地図リアクション付きの${selectedMessages.length}件を確認します。`
  );

  for (
    const message
    of selectedMessages
  ) {
    const reaction =
      getMapReaction(
        message
      );

    const approved =
      await wasApprovedByOwner(
        message,
        reaction,
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

          previousSpotsById.get(
            message.id
          )
        );

      if (
        spot
      ) {
        approvedSpots.push(
          spot
        );
      }

    } catch (
      error
    ) {
      console.warn(
        `投稿 ${message.id} の処理に失敗しました: ${error.message}`
      );

      const previousSpot =
        previousSpotsById.get(
          message.id
        );

      if (
        previousSpot
      ) {
        approvedSpots.push(
          previousSpot
        );
      }
    }
  }

  approvedSpots.sort(
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
      approvedSpots,
      null,
      2
    )}\n`,

    "utf8"
  );

  console.log(
    `${approvedSpots.length}件の承認済みスポットを map/spots.json に保存しました。`
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

      process.exitCode =
        1;
    }
  );
}

module.exports = {
  classifySpot,
  extractAddress,
  extractAddressFromHtml,
  extractAddressFromText,
  extractAreaHint,
  extractCoordinatesFromHtml,
  extractCoordinatesFromUrl,
  extractDescription,
  extractJsonLdBlocks,
  extractPlaceCandidates,
  extractPlaceName,
  extractUrls,
  findStructuredPlace,
  getMapReaction,
  isGoogleMapsUrl,
  normalizeEmoji,
  normalizePlaceName,
  parseCoordinatePair
};
