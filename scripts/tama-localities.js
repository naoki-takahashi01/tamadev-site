"use strict";

// APIに依存せず、スポットの座標から人が検索しやすい地域名を付けるための基準点。
// 新しい開催地域へ広げる場合は、この一覧へ駅を追加する。
const LOCALITY_POINTS = [
  ["聖蹟桜ヶ丘", "聖蹟桜ヶ丘駅", 35.6507, 139.4475],
  ["永山", "永山駅", 35.6309, 139.4480],
  ["多摩センター", "多摩センター駅", 35.6248, 139.4246],
  ["唐木田", "唐木田駅", 35.6168, 139.4113],
  ["南大沢", "南大沢駅", 35.6140, 139.3798],
  ["京王堀之内", "京王堀之内駅", 35.6244, 139.4000],
  ["八王子", "八王子駅", 35.6554, 139.3389],
  ["京王八王子", "京王八王子駅", 35.6578, 139.3420],
  ["西八王子", "西八王子駅", 35.6567, 139.3120],
  ["高尾", "高尾駅", 35.6424, 139.2827],
  ["豊田", "豊田駅", 35.6595, 139.3815],
  ["日野", "日野駅", 35.6792, 139.3939],
  ["高幡不動", "高幡不動駅", 35.6622, 139.4131],
  ["立川", "立川駅", 35.6984, 139.4138],
  ["国立", "国立駅", 35.6990, 139.4463],
  ["府中", "府中駅", 35.6722, 139.4800],
  ["分倍河原", "分倍河原駅", 35.6683, 139.4682],
  ["東府中", "東府中駅", 35.6688, 139.4953],
  ["調布", "調布駅", 35.6518, 139.5447],
  ["柴崎", "柴崎駅", 35.6540, 139.5661],
  ["つつじヶ丘", "つつじヶ丘駅", 35.6580, 139.5751],
  ["仙川", "仙川駅", 35.6623, 139.5849],
  ["稲城", "稲城駅", 35.6360, 139.5000],
  ["若葉台", "若葉台駅", 35.6190, 139.4720],
  ["町田", "町田駅", 35.5420, 139.4455],
  ["玉川学園前", "玉川学園前駅", 35.5633, 139.4630],
  ["吉祥寺", "吉祥寺駅", 35.7031, 139.5798],
  ["三鷹", "三鷹駅", 35.7027, 139.5607],
  ["武蔵境", "武蔵境駅", 35.7021, 139.5446],
  ["武蔵小金井", "武蔵小金井駅", 35.7010, 139.5061],
  ["国分寺", "国分寺駅", 35.7001, 139.4808],
  ["小平", "小平駅", 35.7369, 139.4886],
  ["東村山", "東村山駅", 35.7602, 139.4658],
  ["東大和市", "東大和市駅", 35.7329, 139.4342],
  ["昭島", "昭島駅", 35.7133, 139.3617],
  ["福生", "福生駅", 35.7425, 139.3276],
  ["羽村", "羽村駅", 35.7580, 139.3161],
  ["青梅", "青梅駅", 35.7904, 139.2583],
  ["秋川", "秋川駅", 35.7280, 139.2868]
].map(([locality, station, latitude, longitude]) => ({
  locality,
  station,
  position: [latitude, longitude]
}));

// 自動判定が人の感覚と異なる場合だけ、DiscordのメッセージID単位で上書きする。
// 例: "123456789012345678": { locality: "聖蹟桜ヶ丘", station: "聖蹟桜ヶ丘駅" }
const LOCALITY_OVERRIDES = {};

const MAX_LOCALITY_DISTANCE_KM = 6;

function distanceKm([lat1, lon1], [lat2, lon2]) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function findNearestLocality(position, spotId = "") {
  const baseId = String(spotId).split("-")[0];
  const override = LOCALITY_OVERRIDES[String(spotId)] || LOCALITY_OVERRIDES[baseId];

  if (override) {
    return { ...override, distanceKm: null, source: "override" };
  }

  if (
    !Array.isArray(position) ||
    position.length !== 2 ||
    !position.every(Number.isFinite)
  ) {
    return null;
  }

  const nearest = LOCALITY_POINTS
    .map((point) => ({
      ...point,
      distanceKm: distanceKm(position, point.position)
    }))
    .sort((left, right) => left.distanceKm - right.distanceKm)[0];

  if (!nearest || nearest.distanceKm > MAX_LOCALITY_DISTANCE_KM) return null;
  return { ...nearest, source: "nearest-station" };
}

function enrichSpotWithLocality(spot) {
  const nearest = findNearestLocality(spot.position, spot.id);

  if (!nearest) {
    const { locality, nearestStation, stationDistanceKm, ...rest } = spot;
    return rest;
  }

  return {
    ...spot,
    locality: nearest.locality,
    nearestStation: nearest.station,
    ...(nearest.distanceKm === null
      ? {}
      : { stationDistanceKm: Number(nearest.distanceKm.toFixed(2)) })
  };
}

module.exports = {
  LOCALITY_POINTS,
  distanceKm,
  enrichSpotWithLocality,
  findNearestLocality
};
