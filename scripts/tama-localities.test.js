"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  enrichSpotWithLocality,
  findNearestLocality
} = require("./tama-localities");

test("聖蹟桜ヶ丘駅付近のスポットを分類する", () => {
  const result = findNearestLocality([35.649635, 139.448425]);
  assert.equal(result.locality, "聖蹟桜ヶ丘");
  assert.equal(result.station, "聖蹟桜ヶ丘駅");
});

test("多摩センター駅付近のスポットを分類する", () => {
  const result = findNearestLocality([35.6210477, 139.4242849]);
  assert.equal(result.locality, "多摩センター");
});

test("主要駅から遠いスポットへ無理に地域名を付けない", () => {
  assert.equal(findNearestLocality([35.4475136, 139.4795615]), null);
});

test("公開用スポットへ検索用の地域情報を追加する", () => {
  const result = enrichSpotWithLocality({
    id: "example",
    name: "サンプル",
    area: "多摩市",
    position: [35.649635, 139.448425]
  });

  assert.equal(result.locality, "聖蹟桜ヶ丘");
  assert.equal(result.nearestStation, "聖蹟桜ヶ丘駅");
  assert.equal(typeof result.stationDistanceKm, "number");
});
