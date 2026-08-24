"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const DISCORD_API_BASE = "https://discord.com/api/v10";
const MAP_REACTION = "🗺️";
const MAX_MESSAGE_PAGES = 5;
const MAX_REACTION_PAGES = 5;
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_USER_AGENT =
  "tamadev-discord-spots/1.0 (+https://tamadev.jp/map/)";
const SPOTS_PATH = path.join(__dirname, "..", "map", "spots.json");
const GOOGLE_MAPS_HOSTS = new Set([
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
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(
      name + " が未設定です。GitHub Secretsの設定を確認してください。"
    );
  }

  return value.trim();
}

function normalizeEmoji(value) {
  return String(value || "").replace(/\uFE0F/g, "");
}

function isValidPosition(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

function parseCoordinatePair(value) {
  const match = String(value || "").match(
    /(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/
  );

  if (!match) {
    return null;
  }

  const latitude = Number(match[1]);
  const longitude = Number(match[2]);

  return isValidPosition(latitude, longitude)
    ? [latitude, longitude]
    : null;
}

function extractCoordinatesFromUrl(urlString) {
  let parsedUrl;

  try {
    parsedUrl = new URL(urlString);
  } catch {
    return null;
  }

  const decodedUrl = decodeURIComponent(parsedUrl.toString());
  const atCoordinates = decodedUrl.match(
    /@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/
  );

  if (atCoordinates) {
    return parseCoordinatePair(atCoordinates[1] + "," + atCoordinates[2]);
  }

  const placeCoordinates = decodedUrl.match(
    /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/
  );

  if (placeCoordinates) {
    return parseCoordinatePair(
      placeCoordinates[1] + "," + placeCoordinates[2]
    );
  }

  for (const key of ["q", "query", "destination", "ll", "center"]) {
    const position = parseCoordinatePair(parsedUrl.searchParams.get(key));

    if (position) {
      return position;
    }
  }

  return parseCoordinatePair(parsedUrl.pathname);
}

function extractUrls(message) {
  const texts = [message.content || ""];

  for (const embed of message.embeds || []) {
    if (embed.url) {
      texts.push(embed.url);
    }

    if (embed.description) {
      texts.push(embed.description);
    }
  }

  const matches = texts.join("\n").match(/https?:\/\/[^\s<>]+/g) || [];

  return [...new Set(matches.map((url) => url.replace(/[),。、]+$/, "")))];
}

function isGoogleMapsUrl(urlString) {
  try {
    const url = new URL(urlString);

    return (
      GOOGLE_MAPS_HOSTS.has(url.hostname) &&
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

function cleanText(value, maximumLength) {
  return String(value || "")
    .replace(/https?:\/\/[^\s<>]+/g, "")
    .replace(/<@!?\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
}

function extractPlaceName(message, mapsUrl) {
  const content = message.content || "";

  const explicitName = content.match(
    /(?:場所|施設|会場|店名|名称|スポット)\s*[：:]\s*([^\n]+)/u
  );

  if (explicitName) {
    return cleanText(explicitName[1], 80);
  }

  if (mapsUrl) {
    try {
      const parsedUrl = new URL(mapsUrl);

      const placePath = decodeURIComponent(
        parsedUrl.pathname
      ).match(/\/place\/([^/]+)/);

      if (placePath && !parseCoordinatePair(placePath[1])) {
        return cleanText(
          placePath[1].replace(/\+/g, " "),
          80
        );
      }

      for (const key of ["query", "q", "destination"]) {
        const value = parsedUrl.searchParams.get(key);

        if (value && !parseCoordinatePair(value)) {
          return cleanText(value, 80);
        }
      }
    } catch {
      // URLから場所を取得できない場合は本文や記事を確認します。
    }
  }

  const facilityPattern =
    /メッセ|ホール|センター|公園|広場|美術館|博物館|図書館|カフェ|珈琲|コーヒー|書店|駅|会館|プラザ|食堂|レストラン|うどん|そば|パン/u;

  // 記事タイトルの「多摩うどん『ぽんぽこ』」などから店名を取得。
  for (const embed of message.embeds || []) {
    const title = cleanText(embed.title, 160);

    const titledPlace = title.match(
      /^([^「」『』|｜]{1,30})[「『]([^」』]{1,50})[」』]/u
    );

    if (titledPlace && facilityPattern.test(titledPlace[1])) {
      return cleanText(
        titledPlace[1].trim() + " " + titledPlace[2].trim(),
        80
      );
    }
  }

  // 投稿本文や記事説明にある「東京たま未来メッセ」などを取得。
  const texts = [
    ...(message.embeds || []).map((embed) =>
      [embed.title, embed.description].filter(Boolean).join("\n")
    ),
    content
  ];

  const quotedNames = texts.flatMap((text) =>
    [...text.matchAll(/[「『]([^」』]{1,60})[」』]/gu)]
      .map((match) => cleanText(match[1], 80))
      .filter(Boolean)
  );

  const facilityName = quotedNames.find((name) =>
    facilityPattern.test(name)
  );

  if (facilityName) {
    return facilityName;
  }

  if (quotedNames.length > 0) {
    return quotedNames[0];
  }

  const nonUrlLines = content
    .split(/\r?\n/)
    .map((line) => cleanText(line, 100))
    .filter(Boolean)
    .filter(
      (line) =>
        !/^(種類|分類|説明|紹介|日時|開催日)\s*[：:]/u.test(line)
    );

  if (nonUrlLines.length > 0) {
    return nonUrlLines[0].slice(0, 80);
  }

  const embedTitle = (message.embeds || []).find(
    (embed) => embed.title
  );

  return embedTitle ? cleanText(embedTitle.title, 80) : "";
}

function extractDescription(message, placeName) {
  const lines = (message.content || "")
    .split(/\r?\n/)
    .map((line) => cleanText(line, 200))
    .filter(Boolean)
    .filter((line) => line !== placeName)
    .filter((line) =>
      !/^(場所|施設|会場|店名|名称|スポット|種類|分類)\s*[：:]/u.test(line)
    );

  if (lines.length > 0) {
    return cleanText(lines.join(" "), 160);
  }

  const embed = (message.embeds || []).find(
    (item) => item.description || item.title
  );

  return cleanText(
    embed ? (embed.description || embed.title) : "コミュニティで紹介されたスポット。",
    160
  );
}

function classifySpot(message) {
  const text = [
    message.content || "",
    ...(message.embeds || []).map(
      (embed) => [embed.title, embed.description].filter(Boolean).join(" ")
    )
  ].join(" ");

  if (/イベント|開催|お祭り|祭り|フェス|展示|ワークショップ|勉強会|体験会/u.test(text)) {
    return "event";
  }

  if (/お店|飲食|カフェ|珈琲|コーヒー|パン屋|レストラン|ランチ|食堂|書店/u.test(text)) {
    return "shop";
  }

  return "spot";
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function requestDiscord(endpoint, token) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(DISCORD_API_BASE + endpoint, {
      headers: {
        Authorization: "Bot " + token,
        "User-Agent": NOMINATIM_USER_AGENT
      },
      signal: AbortSignal.timeout(15000)
    });

    if (response.status === 429 && attempt < 2) {
      const body = await response.json().catch(() => ({}));
      const retryAfter = Number(body.retry_after || 1);
      await wait(Math.max(retryAfter * 1000, 1000));
      continue;
    }

    if (!response.ok) {
      throw new Error(
        "Discord APIへの接続に失敗しました (" +
          response.status +
          ")。Botの権限、トークン、チャンネルIDを確認してください。"
      );
    }

    return response.json();
  }

  throw new Error("Discord APIのリクエスト制限に達しました。");
}

async function fetchChannelMessages(channelId, token) {
  const messages = [];
  let before = "";

  for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
    const parameters = new URLSearchParams({
      limit: "100"
    });

    if (before) {
      parameters.set("before", before);
    }

    const batch = await requestDiscord(
      "/channels/" + encodeURIComponent(channelId) +
        "/messages?" + parameters.toString(),
      token
    );

    if (!Array.isArray(batch)) {
      throw new Error("Discordの投稿一覧の形式が正しくありません。");
    }

    messages.push(...batch);

    if (batch.length < 100) {
      break;
    }

    before = batch[batch.length - 1].id;
  }

  return messages;
}

function getMapReaction(message) {
  return (message.reactions || []).find(
    (reaction) =>
      normalizeEmoji(reaction.emoji && reaction.emoji.name) ===
        normalizeEmoji(MAP_REACTION)
  );
}

async function wasApprovedByOwner(message, reaction, channelId, token, approverId) {
  let after = "";
  const emoji = encodeURIComponent(reaction.emoji.name);

  for (let page = 0; page < MAX_REACTION_PAGES; page += 1) {
    const parameters = new URLSearchParams({
      limit: "100"
    });

    if (after) {
      parameters.set("after", after);
    }

    const users = await requestDiscord(
      "/channels/" + encodeURIComponent(channelId) +
        "/messages/" + encodeURIComponent(message.id) +
        "/reactions/" + emoji + "?" + parameters.toString(),
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

    if (users.length < 100) {
      return false;
    }

    after = users[users.length - 1].id;
  }

  return false;
}

async function expandMapsUrl(url) {
  if (!url || !isGoogleMapsUrl(url)) {
    return url;
  }

  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": NOMINATIM_USER_AGENT
      },
      signal: AbortSignal.timeout(15000)
    });

    await response.body?.cancel();

    return response.url || url;
  } catch {
    return url;
  }
}

async function findPlace(placeName) {
  const elapsed = Date.now() - previousGeocodingAt;

  if (elapsed < 1100) {
    await wait(1100 - elapsed);
  }

  previousGeocodingAt = Date.now();

  const searchUrl = new URL(NOMINATIM_BASE);
  searchUrl.searchParams.set("format", "jsonv2");
  searchUrl.searchParams.set("q", placeName);
  searchUrl.searchParams.set("countrycodes", "jp");
  searchUrl.searchParams.set("addressdetails", "1");
  searchUrl.searchParams.set("limit", "1");
  searchUrl.searchParams.set("viewbox", "138.95,35.90,139.68,35.42");
  searchUrl.searchParams.set("bounded", "1");

  const response = await fetch(searchUrl, {
    headers: {
      "User-Agent": NOMINATIM_USER_AGENT,
      "Accept-Language": "ja"
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(
      "場所の検索に失敗しました (" + response.status + "): " + placeName
    );
  }

  const results = await response.json();

  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }

  const result = results[0];
  const latitude = Number(result.lat);
  const longitude = Number(result.lon);

  if (!isValidPosition(latitude, longitude)) {
    return null;
  }

  const address = result.address || {};

  return {
    position: [latitude, longitude],
    area: address.city || address.town || address.village || address.county || "多摩地域"
  };
}

async function readExistingSpots() {
  try {
    const contents = await fs.readFile(SPOTS_PATH, "utf8");
    const spots = JSON.parse(contents);

    if (!Array.isArray(spots)) {
      throw new Error("map/spots.json は配列である必要があります。");
    }

    return spots;
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function convertMessageToSpot(message, previousSpot) {
  const revision = message.edited_timestamp || message.timestamp || "";

  if (previousSpot && previousSpot.revision === revision) {
    return previousSpot;
  }

  const urls = extractUrls(message);
  const originalMapsUrl = urls.find(isGoogleMapsUrl);
  const mapsUrl = originalMapsUrl
    ? await expandMapsUrl(originalMapsUrl)
    : "";
  const name = extractPlaceName(message, mapsUrl);

  if (!name) {
    console.warn(
      "投稿 " + message.id +
        " は場所を特定できません。「場所: 施設名」を追加してください。"
    );
    return null;
  }

  let position = mapsUrl ? extractCoordinatesFromUrl(mapsUrl) : null;
  let area = previousSpot && previousSpot.area
    ? previousSpot.area
    : "多摩地域";

  if (!position) {
    const place = await findPlace(name);

    if (!place) {
      console.warn(
        "投稿 " + message.id +
          " の場所を検索できません: " + name +
          "。正式な施設名またはGoogleマップのURLを追加してください。"
      );
      return null;
    }

    position = place.position;
    area = place.area;
  }

  const sourceUrl = urls.find((url) => !isGoogleMapsUrl(url)) || mapsUrl || "";

  return {
    id: message.id,
    name,
    type: classifySpot(message),
    area,
    position,
    description: extractDescription(message, name),
    sourceUrl,
    revision
  };
}

async function main() {
  const token = requiredEnvironmentVariable("DISCORD_BOT_TOKEN");
  const channelId = requiredEnvironmentVariable("DISCORD_CHANNEL_ID");
  const approverId = requiredEnvironmentVariable("DISCORD_APPROVER_USER_ID");
  const previousSpots = await readExistingSpots();
  const previousSpotsById = new Map(
    previousSpots.map((spot) => [spot.id, spot])
  );
  const messages = await fetchChannelMessages(channelId, token);
  const selectedMessages = messages.filter(
    (message) => !message.author?.bot && getMapReaction(message)
  );
  const approvedSpots = [];

  console.log(
    messages.length + "件の投稿から、地図リアクション付きの" +
      selectedMessages.length + "件を確認します。"
  );

  for (const message of selectedMessages) {
    const reaction = getMapReaction(message);
    const approved = await wasApprovedByOwner(
      message,
      reaction,
      channelId,
      token,
      approverId
    );

    if (!approved) {
      continue;
    }

    if (!message.content && !(message.embeds || []).length) {
      console.warn(
        "投稿 " + message.id +
          " の本文を取得できません。MESSAGE CONTENT INTENTを確認してください。"
      );
      continue;
    }

    const spot = await convertMessageToSpot(
      message,
      previousSpotsById.get(message.id)
    );

    if (spot) {
      approvedSpots.push(spot);
    }
  }

  approvedSpots.sort((left, right) => {
    if (left.id === right.id) {
      return 0;
    }

    return BigInt(left.id) > BigInt(right.id) ? -1 : 1;
  });

  await fs.writeFile(
    SPOTS_PATH,
    JSON.stringify(approvedSpots, null, 2) + "\n",
    "utf8"
  );

  console.log(
    approvedSpots.length + "件の承認済みスポットを map/spots.json に保存しました。"
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  classifySpot,
  extractCoordinatesFromUrl,
  extractDescription,
  extractPlaceName,
  extractUrls,
  getMapReaction,
  isGoogleMapsUrl,
  normalizeEmoji,
  parseCoordinatePair
};
