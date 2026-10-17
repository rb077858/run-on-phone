#!/usr/bin/env node
// Downloads a modern Node.js build for Android (aarch64) from the Termux package
// repository, together with all of its shared-library dependencies, and places it
// inside the Android app:
//   app/src/main/jniLibs/arm64-v8a/libnode.so   <- the node executable
//   app/src/main/jniLibs/arm64-v8a/lib*.so       <- shared libraries it needs (renamed,
//                                                  RUNPATH patched to $ORIGIN)
//   app/src/main/assets/runtime/etc/cert.pem    <- CA certificates
//
// Usage:  node tools/fetch-runtime.mjs [nodejs-lts|nodejs]
// Requires the Windows/mac/linux `tar` (bsdtar / libarchive) to unpack .deb files.

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://packages.termux.dev/apt/termux-main";
const ARCH = "aarch64";
const ROOT_PKG = process.argv[2] || "nodejs-lts";
const EXTRA_PKGS = ["ca-certificates"];

const here = path.dirname(fileURLToPath(import.meta.url));
const appMain = path.resolve(here, "..", "app", "src", "main");
const jniDir = path.join(appMain, "jniLibs", "arm64-v8a");
const runtimeDir = path.join(appMain, "assets", "runtime");
// On Windows use the built-in bsdtar (GNU tar from Git Bash cannot read .deb and
// misreads "C:" as a remote host).
const TAR =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "rop-runtime-"));

async function fetchBuf(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function parsePackages(text) {
  const map = new Map();
  for (const block of text.split(/\n\n+/)) {
    const fields = {};
    for (const line of block.split("\n")) {
      const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
      if (m) fields[m[1]] = m[2];
    }
    if (fields.Package) map.set(fields.Package, fields);
  }
  return map;
}

function depsOf(pkg) {
  if (!pkg.Depends) return [];
  return pkg.Depends.split(",")
    .map((d) => d.split("|")[0].trim().replace(/\s*\(.*\)$/, ""))
    .filter(Boolean);
}

console.log(`Fetching package index (${ARCH})...`);
const index = parsePackages(
  (await fetchBuf(`${REPO}/dists/stable/main/binary-${ARCH}/Packages`)).toString("utf8"),
);

const wanted = new Map();
const queue = [ROOT_PKG, ...EXTRA_PKGS];
while (queue.length) {
  const name = queue.shift();
  if (wanted.has(name)) continue;
  const pkg = index.get(name);
  if (!pkg) throw new Error(`Package not found in index: ${name}`);
  wanted.set(name, pkg);
  queue.push(...depsOf(pkg));
}
console.log("Packages:", [...wanted.values()].map((p) => `${p.Package}@${p.Version}`).join(", "));

const extractRoot = path.join(work, "root");
fs.mkdirSync(extractRoot, { recursive: true });
// Symlinks cannot be created reliably on Windows, so we record them from the tar
// listing ("path -> target") and resolve them ourselves. Key: path relative to usr/.
const symlinks = new Map();
const USR = "data/data/com.termux/files/usr/";
for (const pkg of wanted.values()) {
  const deb = path.join(work, path.basename(pkg.Filename));
  const buf = await fetchBuf(`${REPO}/${pkg.Filename}`);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  if (sha !== pkg.SHA256) throw new Error(`SHA256 mismatch for ${pkg.Package}`);
  fs.writeFileSync(deb, buf);
  const debDir = path.join(work, "deb-" + pkg.Package);
  fs.mkdirSync(debDir);
  execFileSync(TAR, ["-xf", deb, "-C", debDir]);
  const data = fs.readdirSync(debDir).find((f) => f.startsWith("data.tar"));
  if (!data) throw new Error(`No data.tar in ${pkg.Package}`);
  const dataPath = path.join(debDir, data);
  const listing = execFileSync(TAR, ["-tvf", dataPath], { maxBuffer: 64 << 20 }).toString("utf8");
  for (const line of listing.split(/\r?\n/)) {
    if (!line.startsWith("l")) continue;
    const m = line.match(/\s(\S+) -> (\S+)$/);
    if (!m) continue;
    const linkPath = m[1].replace(/^\.\//, "");
    if (!linkPath.startsWith(USR)) continue;
    const rel = linkPath.slice(USR.length);
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[2]));
    symlinks.set(rel, target);
  }
  // Extraction errors on symlinks are expected on Windows; regular files still land.
  spawnSync(TAR, ["-xf", dataPath, "-C", extractRoot], { stdio: "ignore" });
  console.log(`  unpacked ${pkg.Package}`);
}

const prefix = path.join(extractRoot, ...USR.split("/").filter(Boolean));

// Resolves a usr-relative path to a real extracted file, following recorded symlinks.
function resolveUsr(rel) {
  for (let i = 0; i < 20; i++) {
    const full = path.join(prefix, ...rel.split("/"));
    if (!symlinks.has(rel) && fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    if (!symlinks.has(rel)) return null;
    const t = symlinks.get(rel);
    if (t.startsWith("/")) return null;
    rel = t;
  }
  return null;
}
const nodeBin = path.join(prefix, "bin", "node");
if (!fs.existsSync(nodeBin)) throw new Error("node binary not found after extraction");

fs.rmSync(runtimeDir, { recursive: true, force: true });
fs.rmSync(jniDir, { recursive: true, force: true });
fs.mkdirSync(path.join(runtimeDir, "etc"), { recursive: true });
fs.mkdirSync(jniDir, { recursive: true });

// --------------------------------------------------------------- ELF helpers
// Minimal reader/patcher for the dynamic section of 64-bit little-endian ELF files.
function readDynamic(b, file) {
  if (b.readUInt32BE(0) !== 0x7f454c46 || b[4] !== 2) throw new Error(`Not ELF64: ${file}`);
  const phoff = Number(b.readBigUInt64LE(0x20));
  const phentsize = b.readUInt16LE(0x36);
  const phnum = b.readUInt16LE(0x38);
  const loads = [];
  let dyn = null;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    const type = b.readUInt32LE(o);
    const offset = Number(b.readBigUInt64LE(o + 8));
    const vaddr = Number(b.readBigUInt64LE(o + 16));
    const filesz = Number(b.readBigUInt64LE(o + 32));
    if (type === 1) loads.push({ offset, vaddr, filesz });
    if (type === 2) dyn = { offset, filesz };
  }
  const toOff = (va) => {
    const l = loads.find((s) => va >= s.vaddr && va < s.vaddr + s.filesz);
    return l ? va - l.vaddr + l.offset : va;
  };
  const entries = [];
  let strtab = 0;
  let strsz = 0;
  if (dyn) {
    for (let o = dyn.offset; o < dyn.offset + dyn.filesz; o += 16) {
      const tag = Number(b.readBigInt64LE(o));
      const val = Number(b.readBigUInt64LE(o + 8));
      if (tag === 0) break;
      entries.push({ tag, val });
      if (tag === 5) strtab = toOff(val);
      if (tag === 10) strsz = val;
    }
  }
  const str = (off) => b.toString("latin1", strtab + off, b.indexOf(0, strtab + off));
  return { entries, strtab, strsz, str };
}

const DT_NEEDED = 1, DT_SONAME = 14, DT_RPATH = 15, DT_RUNPATH = 29;

function elfNeeded(file) {
  const b = fs.readFileSync(file);
  const d = readDynamic(b, file);
  return d.entries.filter((e) => e.tag === DT_NEEDED).map((e) => d.str(e.val));
}

// Android only extracts files named lib*.so from an APK, so "libz.so.1" -> "libz1.so".
// The new name is always one byte shorter, which allows patching strings in place.
const androidName = (name) => name.replace(/^(lib.+)\.so\.(\d+)$/, "$1$2.so");

/** Rewrites library names (NEEDED/SONAME and any matching dynstr string) and RUNPATH. */
function patchElf(file, renames) {
  const b = fs.readFileSync(file);
  const d = readDynamic(b, file);
  const dynstr = b.subarray(d.strtab, d.strtab + d.strsz);
  const replaceAll = (from, to) => {
    const needle = Buffer.from(from + "\0", "latin1");
    const repl = Buffer.alloc(needle.length); // zero padded
    repl.write(to, "latin1");
    let i = 0;
    while ((i = dynstr.indexOf(needle, i)) !== -1) {
      // Only whole strings (preceded by a NUL), not suffixes of longer names.
      if (i === 0 || dynstr[i - 1] === 0) repl.copy(dynstr, i);
      i += needle.length;
    }
  };
  for (const [from, to] of renames) if (from !== to) replaceAll(from, to);
  let hasRunpath = false;
  for (const e of d.entries) {
    if (e.tag === DT_RUNPATH || e.tag === DT_RPATH) {
      hasRunpath = true;
      const old = d.str(e.val);
      const repl = Buffer.alloc(old.length);
      repl.write("$ORIGIN", "latin1");
      repl.copy(b, d.strtab + e.val);
    }
  }
  fs.writeFileSync(file, b);
  return hasRunpath;
}

// ------------------------------------------------- collect needed libraries
// Copy exactly the shared libraries node needs (transitively).
// Libraries not found here (libc.so, libm.so, libdl.so, liblog.so...) come from Android.
const libs = new Map(); // original name -> real file
const pending = [...elfNeeded(nodeBin)];
while (pending.length) {
  const name = pending.shift();
  if (libs.has(name)) continue;
  const real = resolveUsr("lib/" + name);
  if (!real) continue;
  libs.set(name, real);
  pending.push(...elfNeeded(real));
}
const renames = new Map([...libs.keys()].map((n) => [n, androidName(n)]));

// Everything goes to jniLibs: Android installs it into nativeLibraryDir, where apps
// may execute files. node finds its libraries next to itself via RUNPATH=$ORIGIN.
const nodeOut = path.join(jniDir, "libnode.so");
fs.copyFileSync(nodeBin, nodeOut);
if (!patchElf(nodeOut, renames)) throw new Error("node has no RUNPATH to patch");
for (const [name, real] of libs) {
  const out = path.join(jniDir, renames.get(name));
  fs.copyFileSync(real, out);
  const hasRunpath = patchElf(out, renames);
  const needsOwn = elfNeeded(out).some((n) => [...renames.values()].includes(n));
  if (needsOwn && !hasRunpath) console.warn(`  note: ${renames.get(name)} has no RUNPATH`);
}
console.log("Libraries:", [...renames.values()].join(", "));

const cert = path.join(prefix, "etc", "tls", "cert.pem");
if (fs.existsSync(cert)) fs.copyFileSync(cert, path.join(runtimeDir, "etc", "cert.pem"));

const nodePkg = wanted.get(ROOT_PKG);
fs.writeFileSync(path.join(runtimeDir, "version.txt"), `${nodePkg.Package} ${nodePkg.Version}\n`);

fs.rmSync(work, { recursive: true, force: true });
console.log(`Done: node ${nodePkg.Version}, ${libs.size} libraries -> ${jniDir}`);
