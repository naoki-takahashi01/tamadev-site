import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildContext, extractOutputText, topMatches } from "../src/index.js";

const knowledge = {
  community: { name: "多摩.dev" },
  events: [
    { id: "event-1", name: "多摩.dev #1", date: "2026-02-26" },
    { id: "event-5", name: "多摩.dev #5", date: "2026-10-16" }
  ],
  talks: [
    {
      id: "talk-1",
      title: "多摩ニュータウンを、味わう",
      speaker: "Steve Aoki",
      speakerAliases: ["スティーブ", "Solti"]
    },
    {
      id: "talk-2",
      title: "AIツール推進PJで学んだオーナーシップ",
      speaker: "いいづか",
      speakerAliases: []
    }
  ]
};

test("日本語の別名から登壇を検索できる", () => {
  const matches = topMatches(knowledge.talks, "スティーブさんの過去の登壇を教えて", 5);
  assert.equal(matches[0].speaker, "Steve Aoki");
});

test("次回質問では将来のイベントを含める", () => {
  const context = buildContext("次回の多摩.devはいつ？", knowledge, [], new Date("2026-08-26T00:00:00Z"));
  assert.deepEqual(context.events.map((event) => event.id), ["event-5"]);
});

test("Responses APIの出力テキストを取り出せる", () => {
  const text = extractOutputText({
    output: [{ content: [{ type: "output_text", text: "こんにちは" }] }]
  });
  assert.equal(text, "こんにちは");
});

test("実データからスティーブさんの登壇資料を2件返せる", () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const knowledgePath = path.resolve(currentDir, "../../ai/knowledge.json");
  const actualKnowledge = JSON.parse(fs.readFileSync(knowledgePath, "utf8"));
  const context = buildContext(
    "スティーブさんの多摩.devでの過去の登壇内容と資料を教えて！",
    actualKnowledge,
    [],
    new Date("2026-08-26T00:00:00Z")
  );
  const talks = context.talks.filter((talk) => talk.speaker === "Steve Aoki");

  assert.equal(talks.length, 2);
  assert.ok(talks.every((talk) => talk.materialStatus === "published"));
  assert.ok(talks.every((talk) => talk.materialUrl.startsWith("https://speakerdeck.com/player/")));
});
