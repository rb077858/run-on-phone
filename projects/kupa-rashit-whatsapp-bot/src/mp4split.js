// Splits an MP4 into several smaller, independently playable MP4 files, in pure JS
// (the phone has no ffmpeg). Cuts are made at video keyframes, nothing is re-encoded:
// sample tables are rebuilt per part and the sample bytes are copied as-is.
// Each part is written "fast start" (ftyp, moov, mdat). Fragmented MP4 is not supported.
import fs from "node:fs";

// ------------------------------------------------------------------- boxes
function readBoxes(buf, start = 0, end = buf.length) {
  const boxes = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    let hdr = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8));
      hdr = 16;
    } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    boxes.push({ type, start: p, size, hdr, body: p + hdr, end: p + size });
    p += size;
  }
  return boxes;
}

/** Top-level boxes of a file, reading only their headers. */
function fileBoxes(fd, fileSize) {
  const boxes = [];
  const h = Buffer.alloc(16);
  let p = 0;
  while (p + 8 <= fileSize) {
    fs.readSync(fd, h, 0, 16, p);
    let size = h.readUInt32BE(0);
    const type = h.toString("latin1", 4, 8);
    let hdr = 8;
    if (size === 1) {
      size = Number(h.readBigUInt64BE(8));
      hdr = 16;
    } else if (size === 0) size = fileSize - p;
    if (size < hdr) throw new Error("קובץ MP4 פגום");
    boxes.push({ type, start: p, size, hdr });
    p += size;
  }
  return boxes;
}

const child = (buf, box, type) => readBoxes(buf, box.body, box.end).find((b) => b.type === type);

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length);
  h.write(type, 4, "latin1");
  return Buffer.concat([h, body]);
}
const fullBox = (type, version, flags, ...parts) => {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff));
  return box(type, vf, ...parts);
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const u32Array = (arr) => {
  const b = Buffer.alloc(arr.length * 4);
  arr.forEach((n, i) => b.writeUInt32BE(n >>> 0, i * 4));
  return b;
};

// ------------------------------------------------------------------ tracks
function parseTrack(buf, trak) {
  const mdia = child(buf, trak, "mdia");
  const hdlr = child(buf, mdia, "hdlr");
  const handler = buf.toString("latin1", hdlr.body + 8, hdlr.body + 12);
  const mdhd = child(buf, mdia, "mdhd");
  const mdhdV = buf[mdhd.body];
  const timescale = buf.readUInt32BE(mdhd.body + (mdhdV === 1 ? 20 : 12));
  const minf = child(buf, mdia, "minf");
  const stbl = child(buf, minf, "stbl");
  const tables = Object.fromEntries(readBoxes(buf, stbl.body, stbl.end).map((b) => [b.type, b]));
  if (tables.stz2) throw new Error("פורמט MP4 לא נתמך (stz2)");

  // sizes
  const stsz = tables.stsz;
  const constSize = buf.readUInt32BE(stsz.body + 4);
  const count = buf.readUInt32BE(stsz.body + 8);
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = constSize || buf.readUInt32BE(stsz.body + 12 + i * 4);

  // decode times
  const dts = new Float64Array(count);
  const durations = new Uint32Array(count);
  {
    const b = tables.stts.body;
    const n = buf.readUInt32BE(b + 4);
    let s = 0;
    let t = 0;
    for (let e = 0; e < n && s < count; e++) {
      const c = buf.readUInt32BE(b + 8 + e * 8);
      const d = buf.readUInt32BE(b + 12 + e * 8);
      for (let k = 0; k < c && s < count; k++, s++) {
        dts[s] = t;
        durations[s] = d;
        t += d;
      }
    }
  }

  // composition offsets
  let ctts = null;
  let cttsVersion = 0;
  if (tables.ctts) {
    const b = tables.ctts.body;
    cttsVersion = buf[b];
    const n = buf.readUInt32BE(b + 4);
    ctts = new Int32Array(count);
    let s = 0;
    for (let e = 0; e < n && s < count; e++) {
      const c = buf.readUInt32BE(b + 8 + e * 8);
      const o = cttsVersion === 1 ? buf.readInt32BE(b + 12 + e * 8) : buf.readUInt32BE(b + 12 + e * 8);
      for (let k = 0; k < c && s < count; k++, s++) ctts[s] = o;
    }
  }

  // keyframes
  let sync = null;
  if (tables.stss) {
    const b = tables.stss.body;
    const n = buf.readUInt32BE(b + 4);
    sync = new Uint8Array(count);
    for (let e = 0; e < n; e++) sync[buf.readUInt32BE(b + 8 + e * 4) - 1] = 1;
  }

  // file offsets
  const co = tables.stco || tables.co64;
  const chunkCount = buf.readUInt32BE(co.body + 4);
  const chunkOffset = (i) =>
    tables.co64 ? Number(buf.readBigUInt64BE(co.body + 8 + i * 8)) : buf.readUInt32BE(co.body + 8 + i * 4);
  const offsets = new Float64Array(count);
  {
    const b = tables.stsc.body;
    const n = buf.readUInt32BE(b + 4);
    let s = 0;
    for (let e = 0; e < n; e++) {
      const first = buf.readUInt32BE(b + 8 + e * 12) - 1;
      const per = buf.readUInt32BE(b + 12 + e * 12);
      const last = e + 1 < n ? buf.readUInt32BE(b + 8 + (e + 1) * 12) - 1 : chunkCount;
      for (let ch = first; ch < last && s < count; ch++) {
        let off = chunkOffset(ch);
        for (let k = 0; k < per && s < count; k++, s++) {
          offsets[s] = off;
          off += sizes[s];
        }
      }
    }
  }

  // edit list: keep the media start offset (B-frame delay / audio priming)
  let mediaTime = null;
  const edts = child(buf, trak, "edts");
  const elst = edts && child(buf, edts, "elst");
  if (elst) {
    const v = buf[elst.body];
    const n = buf.readUInt32BE(elst.body + 4);
    const entry = v === 1 ? 20 : 12;
    for (let e = 0; e < n; e++) {
      const p = elst.body + 8 + e * entry;
      const mt = v === 1 ? Number(buf.readBigInt64BE(p + 8)) : buf.readInt32BE(p + 4);
      if (mt >= 0) mediaTime = mt;
    }
  }

  return { trak, handler, timescale, count, sizes, dts, durations, ctts, cttsVersion, sync, offsets, mediaTime, tables };
}

// --------------------------------------------------------------- planning
/** Picks cut times (seconds) at video keyframes so each part is at most maxBytes. */
function planCuts(tracks, video, maxBytes, overhead) {
  const prefix = tracks.map((t) => {
    const p = new Float64Array(t.count + 1);
    for (let i = 0; i < t.count; i++) p[i + 1] = p[i] + t.sizes[i];
    return p;
  });
  const indexAt = (t, sec) => {
    // first sample with dts >= sec
    const target = sec * t.timescale;
    let lo = 0;
    let hi = t.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t.dts[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const bytesBefore = (sec) => tracks.reduce((sum, t, i) => sum + prefix[i][indexAt(t, sec)], 0);
  const total = bytesBefore(Infinity);
  const budget = maxBytes - overhead;
  if (total + overhead <= maxBytes) return [];

  const keyTimes = [];
  for (let i = 0; i < video.count; i++) if (!video.sync || video.sync[i]) keyTimes.push(video.dts[i] / video.timescale);

  const target = total / Math.ceil(total / budget);
  const tooBig = () => new Error("יש קטע בין שתי תמונות מפתח שגדול מדי לחלוקה");
  const cuts = [];
  let startBytes = 0;
  let lastKey = null; // last keyframe of the current part that still fits
  const cutAt = (k) => {
    cuts.push(k);
    startBytes = bytesBefore(k);
    lastKey = null;
  };
  for (const k of keyTimes) {
    if (k <= (cuts.at(-1) ?? 0)) continue;
    let used = bytesBefore(k) - startBytes;
    if (used > budget) {
      if (lastKey == null) throw tooBig();
      cutAt(lastKey);
      used = bytesBefore(k) - startBytes;
      if (used > budget) throw tooBig();
    }
    if (used >= target) cutAt(k);
    else lastKey = k;
  }
  if (total - startBytes > budget) {
    if (lastKey == null) throw tooBig();
    cutAt(lastKey);
    if (total - startBytes > budget) throw tooBig();
  }
  return cuts;
}

// ---------------------------------------------------------------- writing
function rleEntries(values) {
  const out = [];
  for (const v of values) {
    const last = out.at(-1);
    if (last && last[1] === v) last[0]++;
    else out.push([1, v]);
  }
  return out;
}

function patchDuration(buf, b, versionOffsetsV0, versionOffsetsV1, duration) {
  const out = Buffer.from(buf.subarray(b.start, b.end));
  const v = out[b.hdr];
  const at = b.hdr + (v === 1 ? versionOffsetsV1 : versionOffsetsV0);
  if (v === 1) out.writeBigUInt64BE(BigInt(Math.round(duration)), at);
  else out.writeUInt32BE(Math.min(0xffffffff, Math.round(duration)), at);
  return out;
}

const copyBox = (buf, b) => buf.subarray(b.start, b.end);

/** Builds the stbl of one track for samples [from, to), with chunk offsets relative to mdat data. */
function buildStbl(buf, t, from, to, chunks) {
  const n = to - from;
  const parts = [copyBox(buf, t.tables.stsd)];
  const stts = rleEntries(Array.from(t.durations.subarray(from, to)));
  parts.push(fullBox("stts", 0, 0, u32(stts.length), u32Array(stts.flat())));
  if (t.ctts) {
    const e = rleEntries(Array.from(t.ctts.subarray(from, to)));
    const body = Buffer.alloc(e.length * 8);
    e.forEach(([c, o], i) => {
      body.writeUInt32BE(c, i * 8);
      if (t.cttsVersion === 1) body.writeInt32BE(o, i * 8 + 4);
      else body.writeUInt32BE(o >>> 0, i * 8 + 4);
    });
    parts.push(fullBox("ctts", t.cttsVersion, 0, u32(e.length), body));
  }
  if (t.sync) {
    const list = [];
    for (let i = from; i < to; i++) if (t.sync[i]) list.push(i - from + 1);
    parts.push(fullBox("stss", 0, 0, u32(list.length), u32Array(list)));
  }
  // stsc: runs of chunks with the same number of samples
  const stsc = [];
  chunks.forEach((c, i) => {
    if (!stsc.length || stsc.at(-1)[1] !== c.count) stsc.push([i + 1, c.count, 1]);
  });
  parts.push(fullBox("stsc", 0, 0, u32(stsc.length), u32Array(stsc.flat())));
  parts.push(fullBox("stsz", 0, 0, u32(0), u32(n), u32Array(Array.from(t.sizes.subarray(from, to)))));
  parts.push(fullBox("stco", 0, 0, u32(chunks.length), u32Array(chunks.map((c) => c.dataOffset))));
  return box("stbl", ...parts);
}

function buildMoov(buf, moovBox, tracks, ranges, chunksPerTrack, movieTimescale, base) {
  const trakBoxes = [];
  let movieDuration = 0;
  tracks.forEach((t, ti) => {
    const [from, to] = ranges[ti];
    const chunks = chunksPerTrack[ti].map((c) => ({ ...c, dataOffset: c.dataOffset + base }));
    let mediaDuration = 0;
    for (let i = from; i < to; i++) mediaDuration += t.durations[i];
    const movieDur = (mediaDuration / t.timescale) * movieTimescale;
    movieDuration = Math.max(movieDuration, movieDur);

    const rebuild = (b) => {
      switch (b.type) {
        case "tkhd":
          return patchDuration(buf, b, 20, 28, movieDur);
        case "mdhd":
          return patchDuration(buf, b, 16, 24, mediaDuration);
        case "edts": {
          if (t.mediaTime == null) return Buffer.alloc(0);
          const entry = Buffer.alloc(20);
          entry.writeBigUInt64BE(BigInt(Math.round(movieDur)), 0);
          entry.writeBigInt64BE(BigInt(t.mediaTime), 8);
          entry.writeUInt32BE(0x00010000, 16);
          return box("edts", fullBox("elst", 1, 0, u32(1), entry));
        }
        case "stbl":
          return buildStbl(buf, t, from, to, chunks);
        case "mdia":
        case "minf":
          return box(b.type, ...readBoxes(buf, b.body, b.end).map(rebuild));
        default:
          return copyBox(buf, b);
      }
    };
    trakBoxes.push(box("trak", ...readBoxes(buf, t.trak.body, t.trak.end).filter((b) => b.type !== "tref").map(rebuild)));
  });
  const children = [];
  for (const b of readBoxes(buf, moovBox.body, moovBox.end)) {
    if (b.type === "mvhd") children.push(patchDuration(buf, b, 16, 24, movieDuration));
    else if (b.type !== "trak" && b.type !== "udta" && b.type !== "meta") children.push(copyBox(buf, b));
  }
  // Only the video/audio tracks we kept (in their original order).
  return box("moov", ...children, ...trakBoxes);
}

/**
 * Splits `input` into parts no bigger than maxBytes. Returns the list of written part
 * paths (`${outPrefix}-1.mp4`, …), or [input] if it already fits.
 */
export function splitMp4(input, outPrefix, maxBytes) {
  const fd = fs.openSync(input, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize <= maxBytes) return [input];
    const top = fileBoxes(fd, fileSize);
    const moovTop = top.find((b) => b.type === "moov");
    const ftypTop = top.find((b) => b.type === "ftyp");
    if (!moovTop) throw new Error("הקובץ אינו MP4 תקין (אין moov)");
    if (top.some((b) => b.type === "moof")) throw new Error("MP4 מקוטע (fragmented) לא נתמך לחלוקה");
    const buf = Buffer.alloc(moovTop.size);
    fs.readSync(fd, buf, 0, moovTop.size, moovTop.start);
    const moov = readBoxes(buf)[0];
    if (child(buf, moov, "mvex")) throw new Error("MP4 מקוטע (fragmented) לא נתמך לחלוקה");
    let ftyp = Buffer.alloc(0);
    if (ftypTop) {
      ftyp = Buffer.alloc(ftypTop.size);
      fs.readSync(fd, ftyp, 0, ftypTop.size, ftypTop.start);
    }
    const mvhd = child(buf, moov, "mvhd");
    const movieTimescale = buf.readUInt32BE(mvhd.body + (buf[mvhd.body] === 1 ? 20 : 12));

    const tracks = readBoxes(buf, moov.body, moov.end)
      .filter((b) => b.type === "trak")
      .map((trak) => parseTrack(buf, trak))
      .filter((t) => (t.handler === "vide" || t.handler === "soun") && t.count > 0);
    const video = tracks.find((t) => t.handler === "vide");
    if (!video) throw new Error("לא נמצא ערוץ וידאו בקובץ");

    const totalSamples = tracks.reduce((s, t) => s + t.count, 0);
    const overhead = 64 * 1024 + ftyp.length + totalSamples * 16;
    const cuts = planCuts(tracks, video, maxBytes, overhead);
    if (!cuts.length) return [input];
    const bounds = [0, ...cuts, Infinity];

    const outputs = [];
    for (let p = 0; p + 1 < bounds.length; p++) {
      const [t0, t1] = [bounds[p], bounds[p + 1]];
      const ranges = tracks.map((t) => {
        let from = 0;
        while (from < t.count && t.dts[from] < t0 * t.timescale) from++;
        let to = from;
        while (to < t.count && t.dts[to] < t1 * t.timescale) to++;
        return [from, to];
      });

      // Interleave ~0.5s chunks of all tracks in time order.
      const chunkList = [];
      tracks.forEach((t, ti) => {
        const [from, to] = ranges[ti];
        let i = from;
        while (i < to) {
          const start = t.dts[i];
          let j = i;
          while (j < to && t.dts[j] - start < t.timescale / 2) j++;
          chunkList.push({ ti, from: i, to: j, time: start / t.timescale });
          i = j;
        }
      });
      chunkList.sort((a, b) => a.time - b.time || a.ti - b.ti);
      const chunksPerTrack = tracks.map(() => []);
      let dataOffset = 0;
      for (const c of chunkList) {
        const t = tracks[c.ti];
        let bytes = 0;
        for (let i = c.from; i < c.to; i++) bytes += t.sizes[i];
        chunksPerTrack[c.ti].push({ count: c.to - c.from, dataOffset });
        c.bytes = bytes;
        dataOffset += bytes;
      }
      const dataSize = dataOffset;

      const moovOut0 = buildMoov(buf, moov, tracks, ranges, chunksPerTrack, movieTimescale, 0);
      const base = ftyp.length + moovOut0.length + 8;
      const moovOut = buildMoov(buf, moov, tracks, ranges, chunksPerTrack, movieTimescale, base);

      const outPath = `${outPrefix}-${p + 1}.mp4`;
      const tmp = outPath + ".part";
      const out = fs.openSync(tmp, "w");
      try {
        fs.writeSync(out, ftyp);
        fs.writeSync(out, moovOut);
        const mdatHdr = Buffer.alloc(8);
        mdatHdr.writeUInt32BE(8 + dataSize);
        mdatHdr.write("mdat", 4, "latin1");
        fs.writeSync(out, mdatHdr);
        // Copy sample bytes, merging contiguous ranges into bigger reads.
        const io = Buffer.alloc(4 * 1024 * 1024);
        let runStart = -1;
        let runLen = 0;
        const flush = () => {
          let done = 0;
          while (done < runLen) {
            const n = Math.min(io.length, runLen - done);
            fs.readSync(fd, io, 0, n, runStart + done);
            fs.writeSync(out, io, 0, n);
            done += n;
          }
          runLen = 0;
        };
        for (const c of chunkList) {
          const t = tracks[c.ti];
          for (let i = c.from; i < c.to; i++) {
            if (runLen && runStart + runLen === t.offsets[i]) runLen += t.sizes[i];
            else {
              flush();
              runStart = t.offsets[i];
              runLen = t.sizes[i];
            }
          }
        }
        flush();
      } finally {
        fs.closeSync(out);
      }
      fs.renameSync(tmp, outPath);
      outputs.push(outPath);
    }
    return outputs;
  } finally {
    fs.closeSync(fd);
  }
}
