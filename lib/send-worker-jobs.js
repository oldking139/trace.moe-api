import Knex from "knex";
import fetch from "node-fetch";
import getSolrCoreList from "./get-solr-core-list.js";

const {
  SOLA_DB_HOST,
  SOLA_DB_PORT,
  SOLA_DB_USER,
  SOLA_DB_PWD,
  SOLA_DB_NAME,
  TRACE_ALGO,
  SOLA_SOLR_LIST,
} = process.env;

const knex = Knex({
  client: "mysql",
  connection: {
    host: SOLA_DB_HOST,
    port: SOLA_DB_PORT,
    user: SOLA_DB_USER,
    password: SOLA_DB_PWD,
    database: SOLA_DB_NAME,
  },
});

const selectCore = (function* (arr) {
  let index = 0;
  while (true) {
    yield arr[index % arr.length];
    index++;
  }
})(getSolrCoreList());

const getLeastPopulatedCore = async () =>
  (
    await Promise.all(
      SOLA_SOLR_LIST.split(",").map((solrUrl) =>
        fetch(`${solrUrl}admin/cores?wt=json`)
          .then((res) => res.json())
          .then(({ status }) => {
            return Object.values(status).map((e) => ({
              name: `${solrUrl}${e.name}`,
              numDocs: e.index.numDocs,
            }));
          })
      )
    )
  )
    .flat()
    .sort((a, b) => a.numDocs - b.numDocs)[0].name;

let mutexA = 0;
let mutexB = 0;

const lookForHashJobs = async (workerPool, ws) => {
  if (mutexA > 0) {
    await new Promise((resolve) => {
      const i = setInterval(() => {
        if (mutexA === 0) {
          clearInterval(i);
          resolve();
        }
      }, 10);
    });
  }
  mutexA = 1; // lock mutexA
  const rows = await knex(TRACE_ALGO).where("status", "UPLOADED");
  if (rows.length) {
    const file = rows[0].path;
    await knex(TRACE_ALGO).where("path", file).update({ status: "HASHING" });
    workerPool.set(ws, { status: "BUSY", type: "hash", file });
    ws.send(JSON.stringify({ file, algo: TRACE_ALGO }));
  } else {
    workerPool.set(ws, { status: "READY", type: "hash", file: "" });
  }
  mutexA = 0; // unlock mutexA
};

const lookForLoadJobs = async (workerPool, ws) => {
  if (mutexB > 0) {
    await new Promise((resolve) => {
      const i = setInterval(() => {
        if (mutexB === 0) {
          clearInterval(i);
          resolve();
        }
      }, 10);
    });
  }
  mutexB = 1; // lock mutexB
  const rows = await knex(TRACE_ALGO).where("status", "HASHED");
  if (rows.length) {
    const file = rows[0].path;
    await knex(TRACE_ALGO).where("path", file).update({ status: "LOADING" });
    workerPool.set(ws, { status: "BUSY", type: "load", file });
    let selectedCore = "";
    if (rows.length < getSolrCoreList().length) {
      console.log("Finding least populated core");
      selectedCore = await getLeastPopulatedCore();
    } else {
      console.log("Choosing next core (round-robin)");
      selectedCore = selectCore.next().value;
    }
    console.log(`Loading ${file} to ${selectedCore}`);
    ws.send(JSON.stringify({ file, core: selectedCore }));
  } else {
    workerPool.set(ws, { status: "READY", type: "load", file: "" });
  }
  mutexB = 0; // unlock mutexB
};

export default async (workerPool) => {
  for (const [ws] of Array.from(workerPool).filter(
    ([_, { status, type, file }]) => status === "READY"
  )) {
    if (workerPool.get(ws).type === "hash") {
      await lookForHashJobs(workerPool, ws);
    } else if (workerPool.get(ws).type === "load") {
      await lookForLoadJobs(workerPool, ws);
    }
    console.log(
      Array.from(workerPool)
        .map(([_, { status, type, file }]) => `${type},${status},${file}`)
        .sort()
    );
  }
};
