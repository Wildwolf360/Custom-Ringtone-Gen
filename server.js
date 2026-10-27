const path = require("path");
const express = require("express");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const PORT = process.env.PORT || 3000;
const MAX_TEXT = 1000;

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/vendor", express.static(path.join(__dirname, "node_modules", "lamejs")));

let voiceCache = null;
async function getVoices() {
  if (voiceCache) return voiceCache;
  const tts = new MsEdgeTTS();
  try {
    const voices = await tts.getVoices();
    voiceCache = voices
      .map((v) => ({
        id: v.ShortName,
        name: v.ShortName.split("-").slice(2).join("-").replace(/Neural$/, ""),
        gender: v.Gender,
        locale: v.Locale,
        language: v.LocaleName || v.Locale,
        personalities: (v.VoiceTag && v.VoiceTag.VoicePersonalities) || [],
      }))
      .sort((a, b) => a.language.localeCompare(b.language) || a.name.localeCompare(b.name));
    return voiceCache;
  } finally {
    tts.close();
  }
}

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

app.get("/api/voices", async (req, res) => {
  try {
    res.json(await getVoices());
  } catch (err) {
    console.error("voices failed:", err);
    res.status(502).json({ error: "Could not load voices. Check your internet connection." });
  }
});

app.post("/api/tts", async (req, res) => {
  const text = String(req.body.text || "").trim();
  const voice = String(req.body.voice || "");
  if (!text) return res.status(400).json({ error: "Text is required." });
  if (text.length > MAX_TEXT) return res.status(400).json({ error: `Text must be under ${MAX_TEXT} characters.` });

  try {
    const voices = await getVoices();
    if (!voices.some((v) => v.id === voice)) return res.status(400).json({ error: "Unknown voice." });

    const rate = clampInt(req.body.rate, -50, 100, 0);
    const pitch = clampInt(req.body.pitch, -50, 50, 0);

    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(escapeXml(text), {
        rate: `${signed(rate)}%`,
        pitch: `${signed(pitch)}Hz`,
      });
      const audio = await new Promise((resolve, reject) => {
        const chunks = [];
        audioStream.on("data", (c) => chunks.push(c));
        audioStream.on("error", reject);
        audioStream.on("close", () => resolve(Buffer.concat(chunks)));
      });
      if (!audio.length) throw new Error("Empty audio returned");
      res.set("Content-Type", "audio/mpeg").send(audio);
    } finally {
      tts.close();
    }
  } catch (err) {
    console.error("tts failed:", err);
    res.status(502).json({ error: "Voice generation failed. Check your internet connection and try again." });
  }
});

app.listen(PORT, () => {
  console.log(`Ringtone Studio running at http://localhost:${PORT}`);
});
