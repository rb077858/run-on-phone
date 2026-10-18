#!/usr/bin/env node
// Publishes a Node.js project to Firestore so the "Run on Phone" Android app can
// download and run it using a 6-digit code.
//
// Usage:
//   node publish.mjs <projectDir>            package + upload (new version)
//   node publish.mjs <projectDir> --dry-run  package only, show what would be uploaded
//   node publish.mjs <projectDir> --info     print the project's code
//
// The project must contain run-on-phone.json (see ../PROJECT_PROMPT.md).
// Credentials: publisher/service-account.json, or GOOGLE_APPLICATION_CREDENTIALS.

import AdmZip from "adm-zip";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHUNK_SIZE = 700 * 1024; // Firestore documents are limited to 1 MiB
const STATE_FILE = ".run-on-phone-state.json";
const MANIFEST_FILE = "run-on-phone.json";
const ALWAYS_EXCLUDE = new Set(["node_modules", ".git", STATE_FILE, ".DS_Store", "Thumbs.db"]);
const BUILD_ONLY_FIELDS = ["build", "include", "exclude"];

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const projectDir = path.resolve(args.find((a) => !a.startsWith("--")) || ".");
const dryRun = flags.has("--dry-run");

// ------------------------------------------------------------------ manifest
const manifestPath = path.join(projectDir, MANIFEST_FILE);
if (!fs.existsSync(manifestPath)) fail(`Missing ${MANIFEST_FILE} in ${projectDir}`);
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (e) {
  fail(`${MANIFEST_FILE} is not valid JSON: ${e.message}`);
}
if (!manifest.name) fail(`${MANIFEST_FILE}: "name" is required`);
if (!manifest.entry) fail(`${MANIFEST_FILE}: "entry" is required (e.g. "index.js")`);
for (const [i, u] of (manifest.ui || []).entries()) {
  if (!u.label || (!u.path && !u.url)) fail(`${MANIFEST_FILE}: ui[${i}] needs "label" and "path" or "url"`);
}

const statePath = path.join(projectDir, STATE_FILE);
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};

if (flags.has("--info")) {
  console.log(state.code ? `Code: ${state.code}` : "Not published yet.");
  process.exit(0);
}

// --------------------------------------------------------------------- build
if (manifest.build) {
  console.log(`▶ Building: ${manifest.build}`);
  execSync(manifest.build, { cwd: projectDir, stdio: "inherit" });
}

// ------------------------------------------------------------------- staging
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "rop-stage-"));
const exclude = new Set((manifest.exclude || []).map((p) => p.replace(/\\/g, "/").replace(/\/$/, "")));

function copyTree(src, rel = "") {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (ALWAYS_EXCLUDE.has(entry.name) || exclude.has(relPath)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(staging, relPath);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyTree(from, relPath);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

if (manifest.include?.length) {
  const list = [...manifest.include, "package.json", "package-lock.json", MANIFEST_FILE];
  for (const item of new Set(list)) {
    const from = path.join(projectDir, item);
    if (!fs.existsSync(from)) continue;
    if (fs.statSync(from).isDirectory()) {
      fs.mkdirSync(path.join(staging, item), { recursive: true });
      copyTree(from, item.replace(/\\/g, "/"));
    } else {
      fs.mkdirSync(path.dirname(path.join(staging, item)), { recursive: true });
      fs.copyFileSync(from, path.join(staging, item));
    }
  }
} else {
  copyTree(projectDir);
}

if (!fs.existsSync(path.join(staging, manifest.entry))) {
  fail(`Entry file "${manifest.entry}" is not in the package (did the build run? is it excluded?)`);
}

// Production dependencies, installed fresh (no devDependencies).
const pkgJson = path.join(staging, "package.json");
if (fs.existsSync(pkgJson)) {
  const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
  if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
    const hasLock = fs.existsSync(path.join(staging, "package-lock.json"));
    const cmd = `npm ${hasLock ? "ci" : "install"} --omit=dev --ignore-scripts --no-audit --no-fund`;
    console.log(`▶ Installing production dependencies: ${cmd}`);
    execSync(cmd, { cwd: staging, stdio: "inherit" });
  }
}

// Native addons are compiled for this PC and cannot load on Android.
const nativeAddons = [];
(function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scan(p);
    else if (e.name.endsWith(".node")) nativeAddons.push(path.relative(staging, p));
  }
})(staging);
if (nativeAddons.length) {
  console.warn("\n⚠ Native addons found. They will NOT load on the phone (use pure-JS alternatives):");
  for (const a of nativeAddons) console.warn("   " + a);
  console.warn("");
}

// ----------------------------------------------------------------------- zip
const zip = new AdmZip();
zip.addLocalFolder(staging);
const zipBuf = zip.toBuffer();
fs.rmSync(staging, { recursive: true, force: true });
const sha256 = crypto.createHash("sha256").update(zipBuf).digest("hex");
const chunkCount = Math.ceil(zipBuf.length / CHUNK_SIZE);
console.log(`▶ Package: ${(zipBuf.length / 1024 / 1024).toFixed(2)} MB in ${chunkCount} chunks`);

const phoneManifest = { ...manifest };
for (const f of BUILD_ONLY_FIELDS) delete phoneManifest[f];

if (dryRun) {
  console.log("Dry run – nothing uploaded. Manifest sent to phone:");
  console.log(JSON.stringify(phoneManifest, null, 2));
  process.exit(0);
}

// ------------------------------------------------------------------ firebase
// Either a service account key, or (with FIREBASE_PROJECT_ID set) the Google login of
// `gcloud auth application-default login`.
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(here, "service-account.json");
const adcProject = process.env.FIREBASE_PROJECT_ID;
if (!fs.existsSync(credPath) && !adcProject) {
  fail(`Firebase service account key not found at ${credPath}\n  See SETUP.md (step "service account").`);
}
const { initializeApp, cert, applicationDefault } = await import("firebase-admin/app");
const { getFirestore, FieldValue } = await import("firebase-admin/firestore");
if (adcProject) {
  initializeApp({ credential: applicationDefault(), projectId: adcProject });
} else {
  initializeApp({ credential: cert(JSON.parse(fs.readFileSync(credPath, "utf8"))) });
}
const db = getFirestore();
const projects = db.collection("projects");

let code = state.code;
if (!code) {
  for (let i = 0; i < 50 && !code; i++) {
    const candidate = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    if (!(await projects.doc(candidate).get()).exists) code = candidate;
  }
  if (!code) fail("Could not find a free code");
}

const docRef = projects.doc(code);
const current = await docRef.get();
const version = (current.exists ? current.get("version") || 0 : 0) + 1;

console.log(`▶ Uploading version ${version} for code ${code}…`);
const chunks = docRef.collection("chunks");
const queue = [...Array(chunkCount).keys()];
async function worker() {
  while (queue.length) {
    const i = queue.shift();
    const data = zipBuf.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    for (let attempt = 1; ; attempt++) {
      try {
        await chunks.doc(`v${version}_${i}`).set({ data });
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    process.stdout.write(`  chunk ${i + 1}/${chunkCount}\r`);
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
console.log("");

await docRef.set({
  manifest: JSON.stringify(phoneManifest),
  name: manifest.name,
  version,
  chunkCount,
  sha256,
  size: zipBuf.length,
  updatedAt: FieldValue.serverTimestamp(),
});

// Remove chunks of older versions.
const old = await chunks.listDocuments();
const stale = old.filter((d) => !d.id.startsWith(`v${version}_`));
for (let i = 0; i < stale.length; i += 400) {
  const batch = db.batch();
  stale.slice(i, i + 400).forEach((d) => batch.delete(d));
  await batch.commit();
}

fs.writeFileSync(statePath, JSON.stringify({ code, version, publishedAt: new Date().toISOString() }, null, 2));

console.log(`
══════════════════════════════════════
  ✔ Published "${manifest.name}" v${version}

      CODE:  ${code}

  Phone: Run on Phone → הוסף פרויקט → ${code}
  (already added? ⋮ → בדוק עדכון, or just stop & run)
══════════════════════════════════════
`);
process.exit(0);
