# Ringtone Studio

Create custom ringtones from any text using natural neural voices, with optional music placed in the background, before (front), or after (back) the voice.

## Run

```
npm install
npm start
```

Then open http://localhost:3000. An internet connection is required for voice generation.

## Features

- **Voices**: 300+ Microsoft Edge neural voices in 70+ languages (including Hindi and Indian English). Adjust speed and pitch, and preview before creating.
- **Message**: repeat it several times with a pause between repeats. Includes quick-start templates.
- **Music placement**:
  - **Background**: music plays under the voice, with automatic ducking (music gets quieter while the voice speaks).
  - **Front**: a music intro, then the voice.
  - **Back**: the voice, then a music outro.
  - **Front + Back**: music, voice, then the song continues.
- **Controls**: music start point (skip a song's intro), clip length, volumes, fades, and maximum ringtone length.
- **Export**: MP3 (192 kbps) or WAV.

## How it works

- `server.js` is an Express server that proxies text-to-speech requests to the Edge neural voice service (`msedge-tts`).
- `public/app.js` handles all mixing in the browser with the Web Audio API (`OfflineAudioContext`), so ffmpeg isn't needed. MP3 encoding uses `lamejs`.

## iPhone

iPhones need `.m4r` (AAC). Download the MP3, convert it to M4R with any converter, and sync it via Finder or iTunes. Android accepts MP3 directly.
