#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const EVENTS_DIR = path.join(ROOT, "events");
const OUTPUT_DIR = path.join(ROOT, "ai");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "knowledge.json");

const SPEAKER_ALIASES = {
  "Steve Aoki": ["スティーブ", "スティーブさん", "Steve", "Solti"],
  "髙橋直規（幡ヶ谷亭直吉）": ["髙橋直規", "高橋直規", "直規", "幡ヶ谷亭直吉", "asagayanaoki"],
  "ナカグチ｜しょっち": ["ナカグチ", "しょっち"],
  "Daichi KUDO": ["Daichi", "KUDO", "工藤"]
};

function decodeHtml(value = "") {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(html, pattern) {
  const match = html.match(pattern);
  return match ? decodeHtml(match[1]) : "";
}

function getEventDirectories() {
  return fs.readdirSync(EVENTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function extractTalkCards(html, event) {
  const cards = html.match(/<li class="talkCard">[\s\S]*?<\/li>/g) || [];

  return cards.flatMap((card, index) => {
    const title = firstMatch(card, /<h4 class="talkTitle">([\s\S]*?)<\/h4>/i);
    const speakerBlock = card.match(/<div class="speaker">([\s\S]*?)<\/div>/i)?.[1] || "";
    const speaker = firstMatch(speakerBlock, /<a[\s\S]*?>([\s\S]*?)<\/a>/i);
    const speakerUrl = speakerBlock.match(/href="([^"]+)"/i)?.[1] || "";
    const badge = firstMatch(card, /<span class="talkBadge">([\s\S]*?)<\/span>/i);
    const speakerDeckUrl = card.match(/src="(https:\/\/speakerdeck\.com\/player\/[^"]+)"/i)?.[1] || "";
    const docswellUrl = card.match(/<div class="docswell-link">[\s\S]*?href="([^"]+)"/i)?.[1] || "";
    const directMaterialUrl = card.match(/class="talkLink"[^>]*href="([^"]+)"/i)?.[1] || "";
    const unavailable = /資料：(公開なし|非公開)/.test(card);

    if (!title || !speaker) return [];

    return [{
      id: `talk-${event.date}-${index + 1}`,
      type: "talk",
      eventName: event.name,
      eventDate: event.date,
      eventUrl: event.url,
      title,
      format: badge,
      speaker,
      speakerAliases: SPEAKER_ALIASES[speaker] || [],
      speakerUrl,
      materialUrl: speakerDeckUrl || docswellUrl || directMaterialUrl,
      materialStatus: speakerDeckUrl || docswellUrl || directMaterialUrl
        ? "published"
        : unavailable
          ? "unavailable"
          : "unknown"
    }];
  });
}

function extractEvent(directory) {
  const htmlPath = path.join(EVENTS_DIR, directory, "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  const name = firstMatch(html, /<h1>([\s\S]*?)<\/h1>/i) || `多摩.dev ${directory}`;
  const startDate = html.match(/"startDate"\s*:\s*"([^"]+)"/i)?.[1]
    || html.match(/<time[^>]+datetime="([^"]+)"/i)?.[1]
    || `${directory.slice(0, 4)}-${directory.slice(4, 6)}-${directory.slice(6, 8)}`;
  const venue = firstMatch(html, /<dt>会場<\/dt>\s*<dd>([\s\S]*?)<\/dd>/i);
  const connpassUrl = html.match(/href="(https:\/\/tamadev\.connpass\.com\/event\/[^"/]+\/?)"/i)?.[1] || "";
  const url = `https://tamadev.jp/events/${directory}/`;
  const event = {
    id: `event-${directory}`,
    type: "event",
    name,
    date: startDate.slice(0, 10),
    startDate,
    venue,
    url,
    connpassUrl
  };

  return { event, talks: extractTalkCards(html, event) };
}

const extracted = getEventDirectories().map(extractEvent);
const knowledge = {
  generatedAt: new Date().toISOString(),
  scope: "多摩.devと東京都多摩地域に関する公開情報",
  community: {
    name: "多摩.dev",
    description: "多摩地域のエンジニアが、気軽に集まり、学び、つながるコミュニティです。初参加、登壇なし、多摩地域外からの参加も歓迎しています。",
    officialUrl: "https://tamadev.jp/",
    eventsUrl: "https://tamadev.jp/events/",
    mapUrl: "https://tamadev.jp/map/",
    supportUrl: "https://tamadev.jp/support/",
    connpassUrl: "https://tamadev.connpass.com/",
    discordUrl: "https://discord.com/invite/X9R3zVrtxx"
  },
  events: extracted.map(({ event }) => event),
  talks: extracted.flatMap(({ talks }) => talks)
};

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(knowledge, null, 2)}\n`);
console.log(`Wrote ${knowledge.events.length} events and ${knowledge.talks.length} talks to ${path.relative(ROOT, OUTPUT_FILE)}`);
