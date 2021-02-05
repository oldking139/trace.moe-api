require("dotenv").config();
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const child_process = require("child_process");
const fetch = require("node-fetch");
const fs = require("fs-extra");
const aniep = require("aniep");
const cv = require("opencv4nodejs");
const redis = require("redis");
const client = redis.createClient();
const util = require("util");
const getAsync = util.promisify(client.get).bind(client);
const ttlAsync = util.promisify(client.ttl).bind(client);

const {
  SOLA_SOLR_URL,
  SOLA_SOLR_CORE,
  SOLA_DB_HOST,
  SOLA_DB_PORT,
  SOLA_DB_USER,
  SOLA_DB_PWD,
  SOLA_DB_NAME,
  ANIME_DB_HOST,
  ANIME_DB_PORT,
  ANIME_DB_USER,
  ANIME_DB_PWD,
  ANIME_DB_NAME,
  TRACE_MEDIA_SALT,
} = process.env;

const knex = require("knex")({
  client: "mysql",
  connection: {
    host: ANIME_DB_HOST,
    port: ANIME_DB_PORT,
    user: ANIME_DB_USER,
    password: ANIME_DB_PWD,
    database: ANIME_DB_NAME,
  },
});

module.exports = async (ctx) => {
  let searchImage;
  if (ctx.request.query.url) {
    const res = await fetch(
      `https://trace.moe/image-proxy?url=${encodeURIComponent(
        decodeURIComponent(ctx.request.query.url)
      )}`
    );
    if (res.headers.get("Content-Type") && res.headers.get("Content-Type").startsWith("video/")) {
      const tempVideoPath = path.join(os.tmpdir(), `queryVideo${process.hrtime().join("")}.mp4`);
      const tempImagePath = path.join(os.tmpdir(), `queryImage${process.hrtime().join("")}.jpg`);
      await fs.writeFile(tempVideoPath, await res.buffer());
      child_process.spawnSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "warning",
          "-nostats",
          "-y",
          "-ss",
          "00:00:00",
          "-i",
          tempVideoPath,
          "-vframes",
          "1",
          "-vf",
          "scale=320:-2",
          "-crf",
          "23",
          "-preset",
          "faster",
          tempImagePath,
        ],
        { encoding: "utf-8" }
      );
      searchImage = fs.readFileSync(tempImagePath);
      fs.removeSync(tempVideoPath);
      fs.removeSync(tempImagePath);
    } else {
      searchImage = await res.buffer();
    }
  } else if (ctx.file) {
    searchImage = ctx.file.buffer;
  }

  if (true) {
    // crop image or not
    const image = cv.imdecode(searchImage);
    const [height, width] = image.sizes;
    // Find the largest rectangle
    let { x, y, width: w, height: h } = image
      .bgrToGray()
      .threshold(8, 255, cv.THRESH_BINARY)
      .findContours(cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
      .sort((c0, c1) => c1.area - c0.area)[0]
      .boundingRect();

    // For images that is not near 16:9, ensure bounding rect is at least 16:9 or taller
    // And its detected bounding rect wider than 16:9
    if (Math.abs(width / height - 16 / 9) < 0.03 && w / h - 16 / 9 > 0.03) {
      // increase top and bottom margin
      const newHeight = (w / 16) * 9;
      y = y - (newHeight - h) / 2;
      h = newHeight;
    }
    // ensure the image has dimension
    y = y < 0 ? 0 : y;
    x = x < 0 ? 0 : x;
    w = w < 1 ? 1 : w;
    h = h < 1 ? 1 : h;

    const croppedImage = image.getRegion(new cv.Rect(x, y, w, h)).resize(320, 180);
    // cv.imwrite("./test.png", croppedImage);
    searchImage = cv.imencode(".jpg", croppedImage);
  }

  const solrResult = (
    await Promise.all(
      ctx.coreList.map((coreList) =>
        fetch(
          `${coreList}/lireq?${[
            "field=cl_ha",
            "ms=false",
            `accuracy=${Number(ctx.query.trial || 0)}`,
            "candidates=100000",
            "rows=10",
          ].join("&")}`,
          {
            method: "POST",
            body: searchImage,
          }
        ).then((res) => res.json())
      )
    )
  ).reduce(
    (list, { RawDocsCount, RawDocsSearchTime, ReRankSearchTime, response }) => ({
      RawDocsCount: list.RawDocsCount + Number(RawDocsCount),
      RawDocsSearchTime: list.RawDocsSearchTime + Number(RawDocsSearchTime),
      ReRankSearchTime: list.ReRankSearchTime + Number(ReRankSearchTime),
      docs: list.docs.concat(response.docs),
    }),
    { RawDocsCount: 0, RawDocsSearchTime: 0, ReRankSearchTime: 0, docs: [] }
  );

  solrResult.docs = solrResult.docs
    .reduce((list, { d, id }) => {
      // merge nearby results within 2 seconds in the same file
      const anilist_id = Number(id.split("/")[0]);
      const file = id.split("/")[1];
      const t = Number(id.split("/")[2]);
      const index = list.findIndex(
        (e) =>
          e.anilist_id === anilist_id &&
          e.file === file &&
          (Math.abs(e.from - t) < 2 || Math.abs(e.to - t) < 2)
      );
      if (index < 0) {
        return list.concat({
          anilist_id,
          file,
          t,
          from: t,
          to: t,
          d,
        });
      } else {
        list[index].from = list[index].from < t ? list[index].from : t;
        list[index].to = list[index].to > t ? list[index].to : t;
        list[index].d = list[index].d < d ? list[index].d : d;
        list[index].t = list[index].d < d ? list[index].t : t;
        return list;
      }
    }, [])
    .sort((a, b) => a.d - b.d)
    .slice(0, 10)
    .map(({ anilist_id, file, t, from, to, d }) => {
      return {
        anilist_id,
        file,
        episode: aniep(file),
        t,
        from,
        to,
        diff: d,
        video: `https://media.trace.moe/video/${anilist_id}/${file}?t=${t}&token=${crypto
          .createHash("sha256")
          .update(`${t}${TRACE_MEDIA_SALT}`)
          .digest("hex")}`,
        image: `https://media.trace.moe/image/${anilist_id}/${file}?t=${t}&token=${crypto
          .createHash("sha256")
          .update(`${t}${TRACE_MEDIA_SALT}`)
          .digest("hex")}`,
      };
    });

  const anilistDB = await knex("anilist_view")
    .select("id", "json")
    .havingIn(
      "id",
      solrResult.docs.map((result) => result.anilist_id)
    );

  ctx.body = {
    limit: 1,
    limit_ttl: 1,
    RawDocsCount: solrResult.RawDocsCount,
    RawDocsSearchTime: solrResult.RawDocsSearchTime,
    ReRankSearchTime: solrResult.ReRankSearchTime,
    docs: solrResult.docs.map((result) => {
      const anilist = JSON.parse(anilistDB.find((e) => e.id === result.anilist_id).json);
      return {
        anilist_id: result.anilist_id,
        file: result.file,
        episode: result.episode,
        t: result.t,
        from: result.from,
        to: result.to,
        diff: result.diff,
        video: result.video,
        image: result.image,
        title_romaji: anilist.title.romaji,
        title_native: anilist.title.native,
        title_english: anilist.title.english,
        title_chinese: anilist.title.chinese,
        is_adult: anilist.isAdult,
      };
    }),
  };
};
