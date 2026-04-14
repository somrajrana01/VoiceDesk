# Groq Coder v4

Stealth AI coding + interview helper.
**System Audio Loopback** captures interviewer's voice directly — no mic bleed, works with headphones.

## Setup

### 1. Install Tesseract
- Windows: https://github.com/UB-Mannheim/tesseract/wiki (add to PATH)
- macOS: `brew install tesseract`
- Linux: `sudo apt install tesseract-ocr`

### 2. Install & run
```
npm install
npm start
```

### 3. Edit config.json
```json
{
  "apiKey": "YOUR_GROQ_API_KEY",
  "model": "llama-3.3-70b-versatile",
  "voiceModel": "whisper-large-v3-turbo"
}
```
Get key: https://console.groq.com

---

## Voice Mode — System Audio Loopback

The voice panel captures **what your PC is playing** (Zoom/Meet/Teams call audio)
directly — not your microphone. Works perfectly with headphones.

**How to use:**
1. Press `Ctrl+Shift+V` to open the voice panel
2. Source is set to **System Audio (loopback)** by default
3. Press **▶ Start**
4. The app listens to your PC's audio output
5. When the interviewer speaks, the waveform reacts
6. Adaptive VAD detects speech vs background noise automatically
7. After ~1.1s of silence following speech, it auto-submits to Whisper → Groq
8. Answer appears in the voice log as "YOU"

**Manual override:** Press **⚡ Send Now** at any time to force-submit the current buffer.

**Audio Sources:**
- 🔊 System Audio (loopback) — captures everything your PC plays (default, works with headphones)
- 🎤 Microphone — use if loopback doesn't work on your system
- 🖥 Screen/Window — specific window audio (refreshed with ↺ button)

## VAD (Voice Activity Detection)
- Learns your background noise floor automatically over the first ~3 seconds
- Yellow dashed line on waveform = current speech threshold
- Green waveform = speech detected, blue = silence/noise
- Ignores background music, fans, keyboard sounds

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+S` | Screenshot → OCR → Groq → answer |
| `Ctrl+Shift+A` | Add page (multi-page mode) |
| `Ctrl+Shift+V` | Toggle voice panel |
| `Ctrl+Shift+D` | Show raw OCR text |
| `Ctrl+Shift+R` | Reset everything |
| `Ctrl+Shift+W` | Hide / show |
| `Ctrl+Shift+E` | Cycle opacity |
| `Ctrl+Shift+M` | Mini mode |
| `Ctrl+Shift+←→↑↓` | Reposition window |
| `Ctrl+Shift+Q` | Quit |

## Stealth
- Excluded from screen recordings (`contentProtection`)
- No taskbar entry (`skipTaskbar`)
- Opacity down to 25%
- Mini mode = 30px title bar only
- Instant hide shortcut
