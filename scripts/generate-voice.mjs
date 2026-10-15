#!/usr/bin/env node
/* ======================================================================
   Whale voice generator — turns every host remark into an mp3.

   Reads LINES straight from public/app.js (so there is one source of
   truth), expands the templated ones ({n} streaks, {rank} rank-ups),
   voices each line with ElevenLabs and writes:
     public/assets/voice/<key>.mp3
     public/assets/voice/manifest.json   { files: { <key>: { file, text } } }
   The app looks a line up by voiceKey(text) — this file's voiceText() /
   voiceKey() MUST stay identical to the ones in public/app.js.

   Usage (normally run by the "Whale voice" GitHub Action):
     ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... node scripts/generate-voice.mjs
   Options:
     --dry    list the lines and keys, generate nothing
     --fake   write short test tones instead of calling ElevenLabs (needs ffmpeg)
   Env:
     ELEVENLABS_MODEL   default eleven_multilingual_v2
     FORCE=1            re-voice every line (e.g. after changing the voice)
   ====================================================================== */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { RANKS } from "../ranks.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.VOICE_OUT || path.join(ROOT, "public", "assets", "voice");
const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");
const FAKE = args.has("--fake");

// ---- keep in sync with public/app.js ----
export function voiceText(text) {
  return String(text)
    .replace(/[^\p{L}\p{N}\s.,!?…:;«»"'()\-—–‑]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
export function voiceKey(text) {
  let h = 0x811c9dc5;
  const t = voiceText(text);
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

// What ElevenLabs hears: same words, friendlier punctuation.
function ttsText(text) {
  return voiceText(text).replace(/‑/g, "-").replace(/…/g, "...");
}

function loadLines() {
  const src = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const start = src.indexOf("const LINES = {");
  const end = src.indexOf("\n};", start);
  if (start < 0 || end < 0) throw new Error("LINES not found in public/app.js");
  const body = src.slice(start + "const LINES = ".length, end + 2);
  return new Function(`return (${body});`)();
}

// Every final string the host can say, templates expanded the same way
// app.js expands them (streak: 2–3 in a row; 4+ uses LINES.proud).
function allLines(LINES) {
  const out = new Set();
  const walk = v => {
    if (typeof v === "string") out.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  const { streak, rankUp, ...rest } = LINES;
  walk(rest);
  for (const n of [2, 3]) streak.forEach(t => out.add(t.replaceAll("{n}", n)));
  for (const r of RANKS.slice(1)) rankUp.forEach(t => out.add(t.replace("{rank}", `${r.icon} ${r.name}`)));
  return [...out].filter(t => voiceText(t));
}

async function elevenlabs(text, { key, voiceId, model }) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_64`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true }
      })
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const detail = (await res.text()).slice(0, 300);
    if (res.status === 429 || res.status >= 500) {
      console.warn(`  ${res.status}, retry ${attempt}/5 …`);
      await new Promise(r => setTimeout(r, 3000 * attempt));
      continue;
    }
    throw new Error(`ElevenLabs ${res.status}: ${detail}`);
  }
  throw new Error("ElevenLabs: too many retries");
}

function fakeTone(text, file) {
  const secs = Math.min(5, Math.max(1.2, [...text].length * 0.05)).toFixed(2);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=180:duration=${secs}`,
    "-af", "volume=0.2", "-b:a", "48k", "-y", file]);
}

async function main() {
  const lines = allLines(loadLines());
  const entries = lines.map(text => ({ key: voiceKey(text), text }));
  const keys = new Set(entries.map(e => e.key));
  if (keys.size !== entries.length) throw new Error("voiceKey collision — rename a line");
  const chars = entries.reduce((n, e) => n + ttsText(e.text).length, 0);
  console.log(`${entries.length} lines, ${chars} characters to voice`);

  if (DRY) { entries.forEach(e => console.log(e.key, ttsText(e.text))); return; }

  fs.mkdirSync(OUT, { recursive: true });
  const manifestPath = path.join(OUT, "manifest.json");
  const old = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};

  const key = process.env.ELEVENLABS_API_KEY;
  // no Voice ID given → keep the voice used last time
  const voiceId = (process.env.ELEVENLABS_VOICE_ID || "").trim() || (old.voiceId !== "fake" ? old.voiceId : "");
  const model = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";
  if (!FAKE && (!key || !voiceId)) {
    const msg = !key ? "ELEVENLABS_API_KEY is not set" : "No Voice ID: pass ELEVENLABS_VOICE_ID once";
    // the automatic run (remarks changed) must not fail before setup is done
    if (process.env.GITHUB_EVENT_NAME === "push") { console.log(`Skipping voice: ${msg}.`); return; }
    throw new Error(msg);
  }
  const sameVoice = old.voiceId === (FAKE ? "fake" : voiceId) && old.model === (FAKE ? "fake" : model);
  const force = process.env.FORCE === "1" || !sameVoice;

  const files = {};
  let made = 0;
  for (const { key: k, text } of entries) {
    const file = `${k}.mp3`;
    const full = path.join(OUT, file);
    if (!force && fs.existsSync(full)) { files[k] = { file, text }; continue; }
    console.log(`  ${k}  ${ttsText(text)}`);
    if (FAKE) fakeTone(text, full);
    else fs.writeFileSync(full, await elevenlabs(ttsText(text), { key, voiceId, model }));
    files[k] = { file, text };
    made++;
  }
  // drop voice files of lines that no longer exist
  for (const f of fs.readdirSync(OUT)) {
    if (f.endsWith(".mp3") && !keys.has(f.slice(0, -4))) { fs.unlinkSync(path.join(OUT, f)); console.log(`  removed ${f}`); }
  }
  fs.writeFileSync(manifestPath, JSON.stringify({
    voiceId: FAKE ? "fake" : voiceId, model: FAKE ? "fake" : model,
    generatedAt: new Date().toISOString(), files
  }, null, 1) + "\n");
  console.log(`done: ${made} new, ${entries.length} total`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
