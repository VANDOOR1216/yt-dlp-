import './style.css';
import { Command, type Child } from '@tauri-apps/plugin-shell';
import { open } from '@tauri-apps/plugin-dialog';
import { downloadDir } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';

type Mode = 'video' | 'audio';

type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled';

interface Settings {
  ytdlpPath: string;
  ffmpegPath: string;
  outputDir: string;
  playlistEnabled: boolean;
  audioFormat: 'mp3';
  mode: Mode;
}

interface Task {
  id: string;
  url: string;
  mode: Mode;
  outputDir: string;
  status: TaskStatus;
  progress?: number;
  log: string[];
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  cancelRequested?: boolean;
}

interface HistoryItem {
  url: string;
  mode: Mode;
  outputDir: string;
  status: 'done' | 'failed' | 'canceled';
  endedAt: number;
  summary?: string;
}

const SETTINGS_KEY = 'ytdlp-ui-settings';
const HISTORY_KEY = 'ytdlp-ui-history';
const HISTORY_LIMIT = 200;

const DEFAULT_YTDLP_PATH =
  'C:\\Users\\VAN DOOR\\Desktop\\yt-dlp\\yt-dlp.exe';
const DEFAULT_FFMPEG_PATH =
  'C:\\Users\\VAN DOOR\\Desktop\\yt-dlp\\ffmpeg-master-latest-win64-gpl-shared\\bin';

const state = {
  settings: {
    ytdlpPath: DEFAULT_YTDLP_PATH,
    ffmpegPath: DEFAULT_FFMPEG_PATH,
    outputDir: '',
    playlistEnabled: false,
    audioFormat: 'mp3' as const,
    mode: 'video' as Mode
  },
  queue: [] as Task[],
  history: [] as HistoryItem[],
  runningTaskId: null as string | null,
  selectedTaskId: null as string | null,
  currentChild: null as Child | null,
  systemPath: '' as string
};

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('App container not found');
}

app.innerHTML = `
  <div class="app">
    <header class="app-header">
      <div>
        <div class="eyebrow">本地调用 yt-dlp.exe</div>
        <h1>yt-dlp 图形界面</h1>
        <div class="subtitle">批量任务 · 队列执行 · 格式选择 · 进度与历史</div>
      </div>
      <div class="header-actions">
        <button id="startQueue" class="btn primary">开始队列</button>
        <button id="cancelCurrent" class="btn ghost">取消当前</button>
      </div>
    </header>

    <div id="statusBar" class="status-bar"></div>

    <div class="grid">
      <section class="card settings">
        <div class="card-title">设置</div>
        <div class="form-row">
          <label>yt-dlp.exe</label>
          <div class="field">
            <input id="ytdlpPath" type="text" spellcheck="false" />
            <button id="pickYtdlp" class="btn subtle">选择</button>
          </div>
        </div>
        <div class="form-row">
          <label>ffmpeg 目录</label>
          <div class="field">
            <input id="ffmpegPath" type="text" spellcheck="false" />
            <button id="pickFfmpeg" class="btn subtle">选择</button>
          </div>
        </div>
        <div class="form-row">
          <label>输出目录</label>
          <div class="field">
            <input id="outputDir" type="text" spellcheck="false" />
            <button id="pickOutputDir" class="btn subtle">选择</button>
          </div>
        </div>
        <div class="form-row split">
          <label>下载模式</label>
          <div class="radio-group">
            <label class="radio">
              <input type="radio" name="mode" value="video" />
              <span>视频</span>
            </label>
            <label class="radio">
              <input type="radio" name="mode" value="audio" />
              <span>音频</span>
            </label>
          </div>
        </div>
        <div class="form-row split">
          <label>音频格式</label>
          <select id="audioFormat">
            <option value="mp3">mp3（默认）</option>
          </select>
        </div>
        <div class="form-row split">
          <label>播放列表</label>
          <label class="toggle">
            <input id="playlistToggle" type="checkbox" />
            <span>允许下载播放列表</span>
          </label>
        </div>
      </section>

      <section class="card input">
        <div class="card-title">链接输入</div>
        <textarea id="urlsInput" rows="8" placeholder="一行一个链接，支持批量粘贴"></textarea>
        <div class="button-row">
          <button id="addQueue" class="btn primary">加入队列</button>
          <button id="clearInput" class="btn subtle">清空输入</button>
        </div>
      </section>

      <section class="card queue">
        <div class="card-title">
          队列
          <span id="queueSummary" class="summary"></span>
        </div>
        <div id="queueList" class="queue-list"></div>
      </section>

      <section class="card log">
        <div class="card-title" id="logTitle">日志</div>
        <pre id="logBody" class="log-body">尚未选择任务</pre>
      </section>

      <section class="card history">
        <div class="card-title">
          历史记录
          <span class="summary">最近 ${HISTORY_LIMIT} 条</span>
        </div>
        <div id="historyList" class="history-list"></div>
      </section>
    </div>
  </div>
`;

const els = {
  statusBar: document.querySelector<HTMLDivElement>('#statusBar')!,
  ytdlpPath: document.querySelector<HTMLInputElement>('#ytdlpPath')!,
  ffmpegPath: document.querySelector<HTMLInputElement>('#ffmpegPath')!,
  outputDir: document.querySelector<HTMLInputElement>('#outputDir')!,
  playlistToggle: document.querySelector<HTMLInputElement>('#playlistToggle')!,
  audioFormat: document.querySelector<HTMLSelectElement>('#audioFormat')!,
  modeRadios: Array.from(
    document.querySelectorAll<HTMLInputElement>('input[name="mode"]')
  ),
  pickYtdlp: document.querySelector<HTMLButtonElement>('#pickYtdlp')!,
  pickFfmpeg: document.querySelector<HTMLButtonElement>('#pickFfmpeg')!,
  pickOutputDir: document.querySelector<HTMLButtonElement>('#pickOutputDir')!,
  urlsInput: document.querySelector<HTMLTextAreaElement>('#urlsInput')!,
  addQueue: document.querySelector<HTMLButtonElement>('#addQueue')!,
  clearInput: document.querySelector<HTMLButtonElement>('#clearInput')!,
  startQueue: document.querySelector<HTMLButtonElement>('#startQueue')!,
  cancelCurrent: document.querySelector<HTMLButtonElement>('#cancelCurrent')!,
  queueList: document.querySelector<HTMLDivElement>('#queueList')!,
  queueSummary: document.querySelector<HTMLSpanElement>('#queueSummary')!,
  logTitle: document.querySelector<HTMLDivElement>('#logTitle')!,
  logBody: document.querySelector<HTMLPreElement>('#logBody')!,
  historyList: document.querySelector<HTMLDivElement>('#historyList')!
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function loadSettings() {
  const saved = safeJsonParse<Partial<Settings>>(
    localStorage.getItem(SETTINGS_KEY),
    {}
  );
  state.settings = {
    ...state.settings,
    ...saved
  };
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function loadHistory() {
  state.history = safeJsonParse<HistoryItem[]>(
    localStorage.getItem(HISTORY_KEY),
    []
  );
}

function saveHistory() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
}

function setStatus(message: string, tone: 'info' | 'warn' | 'error' = 'info') {
  els.statusBar.textContent = message;
  els.statusBar.dataset.tone = tone;
  if (!message) {
    els.statusBar.removeAttribute('data-tone');
  }
}

function getDir(path: string) {
  const normalized = path.replace(/\//g, '\\');
  const lastSlash = normalized.lastIndexOf('\\');
  if (lastSlash === -1) {
    return '.';
  }
  return normalized.slice(0, lastSlash);
}

function buildSpawnEnv() {
  const paths: string[] = [];
  const ytdlpDir = getDir(state.settings.ytdlpPath);
  if (ytdlpDir && ytdlpDir !== '.') {
    paths.push(ytdlpDir);
  }
  if (state.settings.ffmpegPath) {
    paths.push(state.settings.ffmpegPath);
  }
  if (state.systemPath) {
    paths.push(state.systemPath);
  }
  const unique = Array.from(
    new Set(
      paths
        .flatMap((segment) => segment.split(';'))
        .map((segment) => segment.trim())
        .filter(Boolean)
    )
  );
  if (!unique.length) return undefined;
  return { PATH: unique.join(';') };
}

function isYtdlpExecutable(path: string) {
  return path.toLowerCase().endsWith('yt-dlp.exe');
}

function parseUrls(raw: string) {
  const set = new Set<string>();
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((url) => {
      if (set.has(url)) return false;
      set.add(url);
      return true;
    });
}

function createTask(url: string): Task {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url,
    mode: state.settings.mode,
    outputDir: state.settings.outputDir,
    status: 'pending',
    progress: 0,
    log: [],
    createdAt: Date.now()
  };
}

function formatDate(ts: number) {
  const date = new Date(ts);
  return date.toLocaleString();
}

function renderSettings() {
  els.ytdlpPath.value = state.settings.ytdlpPath;
  els.ffmpegPath.value = state.settings.ffmpegPath;
  els.outputDir.value = state.settings.outputDir;
  els.playlistToggle.checked = state.settings.playlistEnabled;
  els.audioFormat.value = state.settings.audioFormat;
  els.modeRadios.forEach((radio) => {
    radio.checked = radio.value === state.settings.mode;
  });
}

function renderQueue() {
  const pending = state.queue.filter((task) => task.status === 'pending').length;
  const running = state.queue.filter((task) => task.status === 'running').length;
  const done = state.queue.filter((task) => task.status === 'done').length;
  const failed = state.queue.filter((task) => task.status === 'failed').length;
  const canceled = state.queue.filter(
    (task) => task.status === 'canceled'
  ).length;

  els.queueSummary.textContent = `待处理 ${pending} · 运行中 ${running} · 完成 ${done} · 失败 ${failed} · 已取消 ${canceled}`;

  if (state.queue.length === 0) {
    els.queueList.innerHTML = `<div class="empty">队列为空，先添加链接。</div>`;
    return;
  }

  els.queueList.innerHTML = state.queue
    .map((task) => {
      const isSelected = task.id === state.selectedTaskId;
      const progress = Math.min(100, Math.max(0, task.progress ?? 0));
      return `
        <div class="queue-item ${task.status} ${
          isSelected ? 'selected' : ''
        }" data-task-id="${task.id}">
          <div class="queue-head">
            <div>
              <div class="queue-url" title="${escapeHtml(task.url)}">${escapeHtml(
        task.url
      )}</div>
              <div class="queue-meta">
                <span class="badge">${task.mode === 'audio' ? '音频' : '视频'}</span>
                <span class="badge ghost">${task.status}</span>
                <span class="muted">${formatDate(task.createdAt)}</span>
              </div>
            </div>
            <div class="queue-actions">
              <button class="btn ghost" data-action="remove" data-task-id="${task.id}">移除</button>
            </div>
          </div>
          <div class="progress">
            <div class="progress-bar" style="width: ${progress}%"></div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderLog() {
  const task = state.queue.find((item) => item.id === state.selectedTaskId);
  if (!task) {
    els.logTitle.textContent = '日志';
    els.logBody.textContent = '尚未选择任务';
    return;
  }
  els.logTitle.textContent = `日志：${task.url}`;
  els.logBody.textContent = task.log.join('\n') || '暂无输出';
  els.logBody.scrollTop = els.logBody.scrollHeight;
}

function renderHistory() {
  if (state.history.length === 0) {
    els.historyList.innerHTML = `<div class="empty">暂无历史记录。</div>`;
    return;
  }

  els.historyList.innerHTML = state.history
    .map((item) => {
      return `
        <div class="history-item ${item.status}">
          <div class="history-url" title="${escapeHtml(item.url)}">${escapeHtml(
        item.url
      )}</div>
          <div class="history-meta">
            <span class="badge">${item.mode === 'audio' ? '音频' : '视频'}</span>
            <span class="badge ghost">${item.status}</span>
            <span class="muted">${formatDate(item.endedAt)}</span>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderAll() {
  renderSettings();
  renderQueue();
  renderLog();
  renderHistory();
}

function appendLog(task: Task, line: string) {
  if (!line) return;
  task.log.push(line);
  if (task.log.length > 500) {
    task.log.splice(0, task.log.length - 500);
  }
  if (task.id === state.selectedTaskId) {
    renderLog();
  }
}

function updateProgressFromLine(task: Task, line: string) {
  const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
  if (match) {
    task.progress = Number(match[1]);
    renderQueue();
  }
}

function normalizeCommandInputs() {
  if (!isYtdlpExecutable(state.settings.ytdlpPath)) {
    setStatus('请设置正确的 yt-dlp.exe 路径', 'warn');
    return false;
  }
  if (!state.settings.outputDir) {
    setStatus('请先选择输出目录', 'warn');
    return false;
  }
  return true;
}

function hasOriginalNote(formatNote: unknown) {
  if (typeof formatNote !== 'string') return false;
  return /(original|原声|原音|原始)/i.test(formatNote);
}

type AudioPickReason =
  | 'explicit-original'
  | 'single-language'
  | 'video-language'
  | 'combined-fallback'
  | 'no-language-info';

function normalizeLanguage(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (['und', 'unknown', 'mul', 'zxx'].includes(lowered)) return null;
  return trimmed;
}

function getKnownLanguages(formats: Array<Record<string, unknown>>) {
  const langs = new Set<string>();
  for (const format of formats) {
    const lang = normalizeLanguage(format.language);
    if (lang) langs.add(lang);
  }
  return langs;
}

function pickBestByAbr(formats: Array<Record<string, unknown>>) {
  const sorted = [...formats].sort((a, b) => {
    const abrA = Number(a.abr ?? a.tbr ?? 0);
    const abrB = Number(b.abr ?? b.tbr ?? 0);
    return abrB - abrA;
  });
  return sorted[0];
}

function pickBestCombined(formats: Array<Record<string, unknown>>) {
  const sorted = [...formats].sort((a, b) => {
    const hA = Number(a.height ?? 0);
    const hB = Number(b.height ?? 0);
    if (hA !== hB) return hB - hA;
    const tbrA = Number(a.tbr ?? 0);
    const tbrB = Number(b.tbr ?? 0);
    return tbrB - tbrA;
  });
  return sorted[0];
}

function pickBestAudioFormat(
  formats: Array<Record<string, unknown>>,
  videoLanguage?: string
): {
  id: string;
  note?: string;
  language?: string;
  ext?: string;
  abr?: number;
  reason: AudioPickReason;
  combined: boolean;
} | null {
  const audioOnlyFormats = formats.filter(
    (format) =>
      format.acodec && format.acodec !== 'none' && format.vcodec === 'none'
  );
  const combinedFormats = formats.filter(
    (format) =>
      format.acodec && format.acodec !== 'none' && format.vcodec !== 'none'
  );
  if (!audioOnlyFormats.length && !combinedFormats.length) return null;
  const audioOnlyLangs = getKnownLanguages(audioOnlyFormats);
  const combinedLangs = getKnownLanguages(combinedFormats);

  const originalCandidates = audioOnlyFormats.filter((format) =>
    hasOriginalNote(format.format_note)
  );
  if (originalCandidates.length) {
    const best = pickBestByAbr(originalCandidates);
    return {
      id: String(best.format_id),
      note: typeof best.format_note === 'string' ? best.format_note : undefined,
      language: typeof best.language === 'string' ? best.language : undefined,
      ext: typeof best.ext === 'string' ? best.ext : undefined,
      abr: typeof best.abr === 'number' ? best.abr : undefined,
      reason: 'explicit-original',
      combined: false
    };
  }

  const combinedOriginal = combinedFormats.filter((format) =>
    hasOriginalNote(format.format_note)
  );
  if (combinedOriginal.length) {
    const best = pickBestCombined(combinedOriginal);
    return {
      id: String(best.format_id),
      note: typeof best.format_note === 'string' ? best.format_note : undefined,
      language: typeof best.language === 'string' ? best.language : undefined,
      ext: typeof best.ext === 'string' ? best.ext : undefined,
      abr: typeof best.abr === 'number' ? best.abr : undefined,
      reason: 'explicit-original',
      combined: true
    };
  }

  if (videoLanguage) {
    const sameLangAudio = audioOnlyFormats.filter(
      (format) => format.language === videoLanguage
    );
    if (sameLangAudio.length) {
      const best = pickBestByAbr(sameLangAudio);
      return {
        id: String(best.format_id),
        note: typeof best.format_note === 'string' ? best.format_note : undefined,
        language: typeof best.language === 'string' ? best.language : undefined,
        ext: typeof best.ext === 'string' ? best.ext : undefined,
        abr: typeof best.abr === 'number' ? best.abr : undefined,
        reason: 'video-language',
        combined: false
      };
    }

    const sameLangCombined = combinedFormats.filter(
      (format) => format.language === videoLanguage
    );
    if (sameLangCombined.length) {
      const best = pickBestCombined(sameLangCombined);
      return {
        id: String(best.format_id),
        note: typeof best.format_note === 'string' ? best.format_note : undefined,
        language: typeof best.language === 'string' ? best.language : undefined,
        ext: typeof best.ext === 'string' ? best.ext : undefined,
        abr: typeof best.abr === 'number' ? best.abr : undefined,
        reason: 'video-language',
        combined: true
      };
    }
  }

  if (audioOnlyLangs.size === 1) {
    const lang = [...audioOnlyLangs][0];
    const sameLangAudio = audioOnlyFormats.filter(
      (format) => normalizeLanguage(format.language) === lang
    );
    if (sameLangAudio.length) {
      const best = pickBestByAbr(sameLangAudio);
      return {
        id: String(best.format_id),
        note: typeof best.format_note === 'string' ? best.format_note : undefined,
        language: typeof best.language === 'string' ? best.language : undefined,
        ext: typeof best.ext === 'string' ? best.ext : undefined,
        abr: typeof best.abr === 'number' ? best.abr : undefined,
        reason: 'single-language',
        combined: false
      };
    }
  }

  if (combinedLangs.size === 1) {
    const lang = [...combinedLangs][0];
    const sameLangCombined = combinedFormats.filter(
      (format) => normalizeLanguage(format.language) === lang
    );
    if (sameLangCombined.length) {
      const best = pickBestCombined(sameLangCombined);
      return {
        id: String(best.format_id),
        note: typeof best.format_note === 'string' ? best.format_note : undefined,
        language: typeof best.language === 'string' ? best.language : undefined,
        ext: typeof best.ext === 'string' ? best.ext : undefined,
        abr: typeof best.abr === 'number' ? best.abr : undefined,
        reason: 'single-language',
        combined: true
      };
    }
  }

  const hasKnownLanguage = audioOnlyLangs.size > 0 || combinedLangs.size > 0;
  if (!hasKnownLanguage) {
    if (audioOnlyFormats.length) {
      const best = pickBestByAbr(audioOnlyFormats);
      return {
        id: String(best.format_id),
        note: typeof best.format_note === 'string' ? best.format_note : undefined,
        language: typeof best.language === 'string' ? best.language : undefined,
        ext: typeof best.ext === 'string' ? best.ext : undefined,
        abr: typeof best.abr === 'number' ? best.abr : undefined,
        reason: 'no-language-info',
        combined: false
      };
    }
    if (combinedFormats.length) {
      const best = pickBestCombined(combinedFormats);
      return {
        id: String(best.format_id),
        note: typeof best.format_note === 'string' ? best.format_note : undefined,
        language: typeof best.language === 'string' ? best.language : undefined,
        ext: typeof best.ext === 'string' ? best.ext : undefined,
        abr: typeof best.abr === 'number' ? best.abr : undefined,
        reason: 'no-language-info',
        combined: true
      };
    }
  }

  return null;
}

async function resolveOriginalAudioTrack(task: Task) {
  const args = [
    '--js-runtimes',
    'node',
    '--extractor-args',
    'youtube:player_client=web,android',
    '-J',
    '--skip-download'
  ];
  if (!state.settings.playlistEnabled) {
    args.push('--no-playlist');
  }
  args.push(task.url);

  try {
    const command = Command.create('yt-dlp', args, {
      cwd: getDir(state.settings.ytdlpPath),
      encoding: 'utf-8',
      env: buildSpawnEnv()
    });
    const result = await command.execute();
    const stdout = String(result.stdout ?? '').trim();
    if (result.code !== 0 || !stdout) {
      appendLog(task, stdout || String(result.stderr ?? '无法解析视频信息'));
      return null;
    }
    const info = JSON.parse(stdout) as {
      formats?: Array<Record<string, unknown>>;
      language?: string;
    };
    const formats = Array.isArray(info.formats) ? info.formats : [];
    const videoLanguage =
      typeof info.language === 'string' ? info.language : undefined;
    return pickBestAudioFormat(formats, videoLanguage);
  } catch (error) {
    const message = String(error);
    if (message.toLowerCase().includes('program not found')) {
      appendLog(
        task,
        '解析原声音轨失败: 找不到 yt-dlp.exe，请检查设置中的路径'
      );
    } else {
      appendLog(task, `解析原声音轨失败: ${message}`);
    }
    return null;
  }
}


async function runTask(task: Task) {
  if (!normalizeCommandInputs()) return;
  task.status = 'running';
  task.startedAt = Date.now();
  task.progress = 0;
  state.runningTaskId = task.id;
  state.selectedTaskId = task.id;
  renderAll();

  const originalAudioTrack = await resolveOriginalAudioTrack(task);
  if (!originalAudioTrack) {
    task.status = 'failed';
    task.endedAt = Date.now();
    appendLog(
      task,
      '未找到带有原声标记或与视频语言一致的音轨，已停止下载'
    );
    state.runningTaskId = null;
    addToHistory(task);
    renderAll();
    runNext();
    return;
  }
  const reasonText =
    originalAudioTrack.reason === 'explicit-original'
      ? '已匹配原声标记'
      : originalAudioTrack.reason === 'single-language'
        ? '未标记原声，已使用唯一语言音轨'
        : originalAudioTrack.reason === 'video-language'
          ? '未标记原声，按视频语言推断'
          : originalAudioTrack.reason === 'no-language-info'
            ? '未提供语言信息，已使用唯一可用音轨'
            : '未标记原声，已回退到合并格式';
  appendLog(
    task,
    `使用原声音轨: ${originalAudioTrack.id}${
      originalAudioTrack.note ? ` (${originalAudioTrack.note})` : ''
    } · ${reasonText}`
  );

  const args: string[] = [
    '--js-runtimes',
    'node',
    '--extractor-args',
    'youtube:player_client=web,android',
    '--newline'
  ];
  if (!state.settings.playlistEnabled) {
    args.push('--no-playlist');
  }
  if (task.mode === 'audio') {
    args.push('-x', '--audio-format', state.settings.audioFormat);
    args.push('-f', originalAudioTrack.id);
  } else {
    if (originalAudioTrack.combined) {
      args.push('-f', originalAudioTrack.id);
      if (originalAudioTrack.ext && originalAudioTrack.ext !== 'mp4') {
      args.push('--recode-video', 'mp4');
      args.push(
        '--postprocessor-args',
        'VideoConvertor+ffmpeg:-c:v libx264 -crf 20 -preset medium -c:a aac -b:a 192k -movflags +faststart'
      );
      } else {
        args.push('--merge-output-format', 'mp4');
      }
    } else {
      args.push('--merge-output-format', 'mp4');
      args.push(
        '--postprocessor-args',
        'Merger+ffmpeg:-c:v copy -c:a aac -b:a 192k'
      );
      args.push('-f', `bv*+${originalAudioTrack.id}`);
    }
  }
  if (state.settings.ffmpegPath) {
    args.push('--ffmpeg-location', state.settings.ffmpegPath);
  }
  args.push('-P', task.outputDir);
  args.push(task.url);

  try {
    const command = Command.create('yt-dlp', args, {
      cwd: getDir(state.settings.ytdlpPath),
      encoding: 'utf-8',
      env: buildSpawnEnv()
    });

    command.stdout.on('data', (line) => {
      appendLog(task, String(line).trim());
      updateProgressFromLine(task, String(line));
    });

    command.stderr.on('data', (line) => {
      appendLog(task, String(line).trim());
      updateProgressFromLine(task, String(line));
    });

    command.on('error', (error) => {
      appendLog(task, `错误: ${error}`);
    });

    command.on('close', ({ code }) => {
      task.endedAt = Date.now();
      if (task.cancelRequested) {
        task.status = 'canceled';
      } else if (code === 0) {
        task.status = 'done';
        task.progress = 100;
      } else {
        task.status = 'failed';
      }
      state.runningTaskId = null;
      state.currentChild = null;
      addToHistory(task);
      renderAll();
      runNext();
    });

    state.currentChild = await command.spawn();
  } catch (error) {
    task.status = 'failed';
    task.endedAt = Date.now();
    appendLog(task, `执行失败: ${String(error)}`);
    state.runningTaskId = null;
    state.currentChild = null;
    addToHistory(task);
    renderAll();
    runNext();
  }
}

function addToHistory(task: Task) {
  const status: HistoryItem['status'] =
    task.status === 'done'
      ? 'done'
      : task.status === 'canceled'
        ? 'canceled'
        : 'failed';
  state.history.unshift({
    url: task.url,
    mode: task.mode,
    outputDir: task.outputDir,
    status,
    endedAt: task.endedAt ?? Date.now(),
    summary: task.log.slice(-5).join(' ')
  });
  if (state.history.length > HISTORY_LIMIT) {
    state.history = state.history.slice(0, HISTORY_LIMIT);
  }
  saveHistory();
}

function runNext() {
  if (state.runningTaskId) return;
  const next = state.queue.find((task) => task.status === 'pending');
  if (!next) return;
  runTask(next);
}

function startQueue() {
  if (!normalizeCommandInputs()) return;
  if (!state.queue.length) {
    setStatus('队列为空，先添加链接。', 'warn');
    return;
  }
  setStatus('');
  runNext();
}

async function cancelCurrent() {
  if (!state.currentChild || !state.runningTaskId) {
    setStatus('没有正在运行的任务。', 'warn');
    return;
  }
  const task = state.queue.find((item) => item.id === state.runningTaskId);
  if (!task) return;
  task.cancelRequested = true;
  try {
    await state.currentChild.kill();
    appendLog(task, '已请求取消任务');
  } catch (error) {
    appendLog(task, `取消失败: ${String(error)}`);
  }
}

function handleQueueClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const actionEl = target.closest<HTMLElement>('[data-action]');
  const itemEl = target.closest<HTMLElement>('.queue-item');

  if (actionEl) {
    const action = actionEl.dataset.action;
    const taskId = actionEl.dataset.taskId;
    if (!taskId) return;

    if (action === 'remove') {
      const task = state.queue.find((item) => item.id === taskId);
      if (!task) return;
      if (task.status === 'running') {
        setStatus('运行中的任务不能移除，请先取消。', 'warn');
        return;
      }
      const index = state.queue.findIndex((item) => item.id === taskId);
      if (index >= 0) {
        state.queue.splice(index, 1);
        if (state.selectedTaskId === taskId) {
          state.selectedTaskId = state.queue[0]?.id ?? null;
        }
        renderAll();
      }
    }
    return;
  }

  if (itemEl?.dataset.taskId) {
    state.selectedTaskId = itemEl.dataset.taskId;
    renderLog();
    renderQueue();
  }
}

function bindEvents() {
  els.ytdlpPath.addEventListener('change', () => {
    state.settings.ytdlpPath = els.ytdlpPath.value.trim();
    saveSettings();
  });

  els.ffmpegPath.addEventListener('change', () => {
    state.settings.ffmpegPath = els.ffmpegPath.value.trim();
    saveSettings();
  });

  els.outputDir.addEventListener('change', () => {
    state.settings.outputDir = els.outputDir.value.trim();
    saveSettings();
  });

  els.playlistToggle.addEventListener('change', () => {
    state.settings.playlistEnabled = els.playlistToggle.checked;
    saveSettings();
  });

  els.audioFormat.addEventListener('change', () => {
    state.settings.audioFormat = els.audioFormat.value as 'mp3';
    saveSettings();
  });

  els.modeRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) {
        state.settings.mode = radio.value as Mode;
        saveSettings();
      }
    });
  });

  els.pickYtdlp.addEventListener('click', async () => {
    const selected = await open({
      filters: [{ name: 'yt-dlp', extensions: ['exe'] }],
      multiple: false
    });
    if (typeof selected === 'string') {
      state.settings.ytdlpPath = selected;
      saveSettings();
      renderSettings();
    }
  });

  els.pickFfmpeg.addEventListener('click', async () => {
    const selected = await open({
      directory: true,
      multiple: false
    });
    if (typeof selected === 'string') {
      state.settings.ffmpegPath = selected;
      saveSettings();
      renderSettings();
    }
  });

  els.pickOutputDir.addEventListener('click', async () => {
    const selected = await open({
      directory: true,
      multiple: false
    });
    if (typeof selected === 'string') {
      state.settings.outputDir = selected;
      saveSettings();
      renderSettings();
    }
  });

  els.addQueue.addEventListener('click', () => {
    const urls = parseUrls(els.urlsInput.value);
    if (!urls.length) {
      setStatus('请输入至少一个有效链接。', 'warn');
      return;
    }
    const tasks = urls.map((url) => createTask(url));
    state.queue.push(...tasks);
    state.selectedTaskId = tasks[0]?.id ?? state.selectedTaskId;
    renderAll();
    setStatus(`已加入 ${tasks.length} 条任务。`);
  });

  els.clearInput.addEventListener('click', () => {
    els.urlsInput.value = '';
  });

  els.startQueue.addEventListener('click', startQueue);
  els.cancelCurrent.addEventListener('click', cancelCurrent);

  els.queueList.addEventListener('click', handleQueueClick);
}

async function init() {
  loadSettings();
  loadHistory();
  try {
    const systemPath = await invoke<string>('get_system_path');
    if (systemPath) {
      state.systemPath = systemPath;
    }
  } catch {
    state.systemPath = '';
  }
  if (!state.settings.outputDir) {
    try {
      state.settings.outputDir = await downloadDir();
      saveSettings();
    } catch {
      state.settings.outputDir = 'C:\\Users\\VAN DOOR\\Downloads';
    }
  }
  renderAll();
  bindEvents();
}

init();
