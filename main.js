const { app, BrowserWindow, globalShortcut, screen, ipcMain, desktopCapturer, session } = require('electron');

process.title = 'RuntimeBroker';
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// DO NOT add single-process — breaks packaged exe

const path = require('path');
const screenshot = require('screenshot-desktop');
const fs = require('fs');
const https = require('https');
const { execFile } = require('child_process');
const os = require('os');

// ─── Config ───────────────────────────────────────────────────────────────────
let config;
try {
  const configPath = path.join(__dirname, 'config.json');
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.apiKey) throw new Error('apiKey missing in config.json');
  if (!config.model)      config.model      = 'llama-3.3-70b-versatile';
  if (!config.voiceModel) config.voiceModel = 'whisper-large-v3-turbo';
} catch (err) {
  console.error('Config error:', err.message);
  app.quit();
}

// ─── Groq Chat API ────────────────────────────────────────────────────────────
function callGroqAPI(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: config.model, messages, max_tokens: 8000, temperature: 0.25 });
    const req = https.request({
      hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}`, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) return reject(new Error('Groq: ' + p.error.message));
          if (!p.choices?.[0]) return reject(new Error('Empty response'));
          resolve(p.choices[0].message.content);
        } catch (e) { reject(new Error('Parse: ' + e.message)); }
      });
    });
    req.on('error', e => reject(new Error('Network: ' + e.message)));
    req.setTimeout(90000, () => { req.destroy(); reject(new Error('Timed out')); });
    req.write(body); req.end();
  });
}

// ─── Groq Whisper ────────────────────────────────────────────────────────────
function transcribeWithGroq(audioBuffer, mimeType) {
  return new Promise((resolve, reject) => {
    const boundary = '----GroqBoundary' + Date.now();
    const filename = 'audio.webm';
    const pre = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const modelPart = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${config.voiceModel}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n--${boundary}--\r\n`
    );
    const body = Buffer.concat([pre, audioBuffer, modelPart]);
    const req = https.request({
      hostname: 'api.groq.com', path: '/openai/v1/audio/transcriptions', method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Authorization: `Bearer ${config.apiKey}`, 'Content-Length': body.length },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) return reject(new Error('Whisper: ' + p.error.message));
          resolve(p.text?.trim() || '');
        } catch (e) { reject(new Error('Whisper parse: ' + e.message)); }
      });
    });
    req.on('error', e => reject(new Error('Whisper network: ' + e.message)));
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Whisper timed out')); });
    req.write(body); req.end();
  });
}

// ─── OCR ──────────────────────────────────────────────────────────────────────
function runOCR(imagePath) {
  return new Promise((resolve, reject) => {
    execFile('tesseract', [imagePath, 'stdout', '-l', 'eng', '--psm', '6', '--oem', '3'],
      { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error('OCR failed: ' + (stderr || err.message)));
        const text = stdout.trim();
        if (!text) return reject(new Error('OCR found no text.'));
        resolve(text);
      });
  });
}

// ─── System prompts ───────────────────────────────────────────────────────────
const CODING_SYSTEM =
  'You are an elite competitive programmer. The user gives a question (may have OCR typos).\n' +
  '1. Understand the problem, correct any OCR errors.\n' +
  '2. Give the optimal solution with clean, commented code.\n' +
  '3. Briefly explain approach + time/space complexity.\n' +
  '4. Mention alternatives if relevant.\n' +
  'Format: markdown with fenced code blocks.';

const VOICE_SYSTEM =
  'You are a senior software engineer in a live interview. Answer like a human speaking out loud.\n' +
  'STRICT RULES:\n' +
  '- Max 3-4 sentences for concept questions. No fluff.\n' +
  '- No bullet points unless asked. No headers. Just talk.\n' +
  '- For coding: one short sentence on approach, then the code. Nothing else.\n' +
  '- For behavioral: 3-4 sentences max in STAR format. No rambling.\n' +
  '- Never restate the question. Never say "Great question" or "Certainly".\n' +
  '- If you can say it in 2 sentences, do that.\n' +
  'Be direct. Be brief. Sound human.';

// ─── State ────────────────────────────────────────────────────────────────────
let mainWindow;
let ocrTexts = [], multiPageMode = false;
let visible = true, stage = 0, windowPos = null;
let conversationHistory = [], voiceHistory = [];

const OPACITY_STEPS = [1.0, 0.85, 0.65, 0.45, 0.25];
let opacityIdx = 0;
// NOTE: We use CSS opacity on the renderer (not window opacity) so mouse/scroll events still fire
const DEFAULT_HINT = 'S:snap  A:add-page  V:voice  R:reset  W:hide  E:opacity  M:mini  ←→↑↓:move  Q:quit';

function send(ch, ...a) { if (mainWindow?.webContents) mainWindow.webContents.send(ch, ...a); }

// ─── Screenshot → OCR ────────────────────────────────────────────────────────
async function snapAndOCR(label) {
  send('status', label || 'Capturing…');
  mainWindow.hide();
  await new Promise(r => setTimeout(r, 280));
  const imgPath = path.join(os.tmpdir(), `gc_${Date.now()}.png`);
  try {
    await screenshot({ filename: imgPath });
    mainWindow.show();
    send('status', 'Running OCR…');
    return await runOCR(imgPath);
  } finally {
    mainWindow.show();
    try { fs.unlinkSync(imgPath); } catch (_) {}
  }
}

async function processWithGroq() {
  try {
    send('processing', `Sending to Groq (${config.model})…`);
    const combined = ocrTexts.length === 1 ? ocrTexts[0]
      : ocrTexts.map((t, i) => `[Page ${i + 1}]\n${t}`).join('\n\n---\n\n');
    conversationHistory = [
      { role: 'system', content: CODING_SYSTEM },
      { role: 'user', content: `Question:\n\n${combined}\n\nSolve it.` },
    ];
    const result = await callGroqAPI(conversationHistory);
    conversationHistory.push({ role: 'assistant', content: result });
    send('result', result); stage = 2;
  } catch (err) { send('error', err.message); }
}

// ─── Voice: audio blob → Whisper → Groq ──────────────────────────────────────
ipcMain.on('audio-blob', async (event, { buffer, mimeType }) => {
  try {
    send('voice-transcribing');
    const transcript = await transcribeWithGroq(Buffer.from(buffer), mimeType);
    if (!transcript || transcript.length < 3) {
      send('voice-idle'); return;
    }
    if (!voiceHistory.length) voiceHistory.push({ role: 'system', content: VOICE_SYSTEM });
    send('voice-processing', transcript);
    voiceHistory.push({ role: 'user', content: transcript });
    const result = await callGroqAPI(voiceHistory);
    voiceHistory.push({ role: 'assistant', content: result });
    send('voice-result', { question: transcript, answer: result });
  } catch (err) { send('voice-error', err.message); }
});

// ─── Voice: get desktop sources for loopback ──────────────────────────────────
ipcMain.handle('get-desktop-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
  return sources.map(s => ({ id: s.id, name: s.name }));
});

// ─── Follow-up ────────────────────────────────────────────────────────────────
ipcMain.on('follow-up', async (event, question) => {
  if (!conversationHistory.length) { send('error', 'No conversation yet.'); return; }
  try {
    send('processing', 'Asking Groq…');
    conversationHistory.push({ role: 'user', content: question });
    const result = await callGroqAPI(conversationHistory);
    conversationHistory.push({ role: 'assistant', content: result });
    send('followup-result', result);
  } catch (err) { send('error', err.message); }
});

ipcMain.on('voice-reset', () => { voiceHistory = []; });

// ─── Reset ────────────────────────────────────────────────────────────────────
function reset() {
  ocrTexts = []; multiPageMode = false;
  conversationHistory = []; voiceHistory = [];
  stage = 0; send('reset'); send('hint', DEFAULT_HINT);
}

function cycleOpacity() {
  opacityIdx = (opacityIdx + 1) % OPACITY_STEPS.length;
  // Send CSS opacity to renderer — window stays at 1.0 so events always fire
  send('set-opacity', OPACITY_STEPS[opacityIdx]);
  send('hint', `Opacity: ${Math.round(OPACITY_STEPS[opacityIdx] * 100)}% — E to cycle`);
  setTimeout(() => send('hint', DEFAULT_HINT), 1800);
}

function nudge(dx, dy) {
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(x + dx, y + dy);
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  // Allow desktopCapturer / screen capture permissions
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });

  const { width } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: 900, height: 650,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    x: Math.floor((width - 900) / 2), y: 20,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    frame: false, transparent: true,
    alwaysOnTop: true, paintWhenInitiallyHidden: true,
    contentProtection: true, type: 'toolbar',
    skipTaskbar: true, focusable: true,
  });

  mainWindow.loadFile('index.html');
  mainWindow.setContentProtection(true);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  mainWindow.setSkipTaskbar(true);
  mainWindow.setSkipTaskbar(true);


  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    try { const t = await snapAndOCR('Capturing…'); ocrTexts = [t]; await processWithGroq(); }
    catch (e) { send('error', e.message); }
  });
  globalShortcut.register('CommandOrControl+Shift+A', async () => {
    try {
      if (!multiPageMode) { multiPageMode = true; stage = 1; }
      const t = await snapAndOCR(`Capturing page ${ocrTexts.length + 1}…`);
      ocrTexts.push(t);
      send('hint', `${ocrTexts.length} page(s) — Ctrl+Shift+S to solve`);
    } catch (e) { send('error', e.message); }
  });
  globalShortcut.register('CommandOrControl+Shift+V', () => send('toggle-voice'));
  globalShortcut.register('CommandOrControl+Shift+D', () => {
    if (!ocrTexts.length) { send('error', 'No OCR yet.'); return; }
    send('result', '**Raw OCR:**\n\n```\n' + ocrTexts.join('\n\n---\n\n') + '\n```'); stage = 2;
  });
  globalShortcut.register('CommandOrControl+Shift+R', () => reset());
  globalShortcut.register('CommandOrControl+Shift+W', () => {
    if (visible) { windowPos = mainWindow.getPosition(); send('hide-ui'); mainWindow.hide(); visible = false; }
    else { mainWindow.show(); if (windowPos) mainWindow.setPosition(windowPos[0], windowPos[1]); if (stage===2) send('show-ui'); else send('hint', DEFAULT_HINT); visible = true; }
  });
  globalShortcut.register('CommandOrControl+Shift+E', () => cycleOpacity());
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    if (mainWindow.getSize()[1] > 40) { mainWindow.setSize(mainWindow.getSize()[0], 32); send('minimize-ui'); }
    else { mainWindow.setSize(900, 650); send('restore-ui'); }
  });
  globalShortcut.register('CommandOrControl+Shift+Left',  () => nudge(-40, 0));
  globalShortcut.register('CommandOrControl+Shift+Right', () => nudge( 40, 0));
  globalShortcut.register('CommandOrControl+Shift+Up',    () => nudge(0, -40));
  globalShortcut.register('CommandOrControl+Shift+Down',  () => nudge(0,  40));
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { globalShortcut.unregisterAll(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });