#!/usr/bin/env node
// One-time Firebase setup for the public summary page, using a signed-in Google account
// (gcloud auth application-default login). Safe to run again: it refreshes everything.
//   1. Creates the bot's write key (kept when it already exists).
//   2. Deploys ../../../firestore.rules with the key filled in: only the bot may write onegShabat/*.
//   3. Deploys public/ to Firebase Hosting at https://<project>.web.app/oneg-shabat/
//   4. Writes ../firebase-writer.json, which the publisher ships to the phone with the code.
// Usage: node setup-firebase.mjs <firebase-project-id> [--hosting-only]
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.join(here, "..");
const rulesFile = path.join(projectDir, "..", "..", "firestore.rules");
const writerFile = path.join(projectDir, "firebase-writer.json");
const DOC_PATH = "onegShabat/live";
const PAGE_FILES = ["index.html", "app.js", "style.css", "favicon.svg"];

const args = process.argv.slice(2);
const project = args.find((a) => !a.startsWith("--")) || process.env.GOOGLE_CLOUD_PROJECT;
const hostingOnly = args.includes("--hosting-only");
if (!project) {
  console.error("Usage: node setup-firebase.mjs <firebase-project-id>");
  process.exit(1);
}

const token = execSync("gcloud auth application-default print-access-token", { encoding: "utf8" }).trim();

async function api(method, url, body, { allow404 = false, raw = false, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-goog-user-project": project,
      ...(raw ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: raw ? body : body && JSON.stringify(body),
  });
  if (allow404 && res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url.split("?")[0]} → ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

// ------------------------------------------------------------ web api key
async function webApiKey() {
  const base = `https://firebase.googleapis.com/v1beta1/projects/${project}/webApps`;
  let apps = (await api("GET", base)).apps || [];
  if (!apps.length) {
    console.log("▶ Registering a Firebase web app…");
    let op = await api("POST", base, { displayName: "Run on Phone" });
    while (!op.done) {
      await new Promise((r) => setTimeout(r, 2000));
      op = await api("GET", `https://firebase.googleapis.com/v1beta1/${op.name}`);
    }
    apps = (await api("GET", base)).apps || [];
  }
  const cfg = await api("GET", `${base}/${apps[0].appId}/config`);
  return cfg.apiKey;
}

// ----------------------------------------------------------------- rules
async function deployRules(writeKey) {
  const rules = fs.readFileSync(rulesFile, "utf8");
  if (!rules.includes("ONEG_SHABAT_WRITE_KEY")) throw new Error("No oneg-shabat block in firestore.rules");
  const content = rules.replaceAll("ONEG_SHABAT_WRITE_KEY", writeKey);
  const base = `https://firebaserules.googleapis.com/v1/projects/${project}`;
  const ruleset = await api("POST", `${base}/rulesets`, { source: { files: [{ name: "firestore.rules", content }] } });
  const name = `projects/${project}/releases/cloud.firestore`;
  const exists = await api("GET", `${base}/releases/cloud.firestore`, null, { allow404: true });
  if (exists) await api("PATCH", `${base}/releases/cloud.firestore`, { release: { name, rulesetName: ruleset.name } });
  else await api("POST", `${base}/releases`, { name, rulesetName: ruleset.name });
  console.log("✔ Firestore rules deployed");
}

// --------------------------------------------------------------- hosting
async function deployHosting(apiKey) {
  const sites = (await api("GET", `https://firebasehosting.googleapis.com/v1beta1/projects/${project}/sites`)).sites || [];
  const site = (sites.find((s) => s.type === "DEFAULT_SITE") || sites[0])?.name?.split("/").pop() || project;
  const configJs = `window.ONEG_CONFIG = ${JSON.stringify({ source: "firestore", projectId: project, apiKey, docPath: DOC_PATH })};\n`;
  const files = {};
  for (const f of PAGE_FILES) files[`/oneg-shabat/${f}`] = fs.readFileSync(path.join(projectDir, "public", f));
  files["/oneg-shabat/config.js"] = Buffer.from(configJs);
  files["/index.html"] = Buffer.from('<!doctype html><meta http-equiv="refresh" content="0;url=/oneg-shabat/">');

  const gz = {};
  const hashes = {};
  for (const [p, buf] of Object.entries(files)) {
    gz[p] = zlib.gzipSync(buf);
    hashes[p] = crypto.createHash("sha256").update(gz[p]).digest("hex");
  }
  const version = await api("POST", `https://firebasehosting.googleapis.com/v1beta1/sites/${site}/versions`, {
    config: {
      trailingSlashBehavior: "ADD",
      headers: [{ glob: "**", headers: { "Cache-Control": "no-cache" } }],
    },
  });
  const pop = await api("POST", `https://firebasehosting.googleapis.com/v1beta1/${version.name}:populateFiles`, { files: hashes });
  for (const h of pop.uploadRequiredHashes || []) {
    const p = Object.keys(hashes).find((k) => hashes[k] === h);
    await api("POST", `${pop.uploadUrl}/${h}`, gz[p], { raw: true, headers: { "content-type": "application/octet-stream" } });
  }
  await api("PATCH", `https://firebasehosting.googleapis.com/v1beta1/${version.name}?update_mask=status`, { status: "FINALIZED" });
  await api("POST", `https://firebasehosting.googleapis.com/v1beta1/sites/${site}/releases?versionName=${version.name}`, {});
  const url = `https://${site}.web.app/oneg-shabat/`;
  console.log(`✔ Public page deployed: ${url}`);
  return url;
}

const apiKey = await webApiKey();
const publicUrl = await deployHosting(apiKey);
const previous = fs.existsSync(writerFile) ? JSON.parse(fs.readFileSync(writerFile, "utf8")) : {};
const writeKey = previous.writeKey || crypto.randomBytes(24).toString("hex");
if (!hostingOnly) await deployRules(writeKey);
fs.writeFileSync(writerFile, JSON.stringify({ projectId: project, apiKey, writeKey, docPath: DOC_PATH, publicUrl }, null, 2));
console.log(`✔ Wrote ${writerFile} (shipped to the phone by publish.mjs, not committed)`);
console.log(`\nPublic link: ${publicUrl}`);
