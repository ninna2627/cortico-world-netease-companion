import { customPlayerIds, isAutoPlayer, matchPlayer, parseAutoBlacklist, parseCustomPlayers, playerOrder, type MusicConfig } from './config.ts';
import { busctl, playerMatchText, readMprisPlayers, type BusRunner, type MprisPlayer } from './mpris.ts';
import { TrackSelector, type Selection, type SelectorState } from './selection.ts';
import { parseCandidates, type MediaCandidates, type SessionCandidate, type Snapshot, type WindowCandidate } from './state.ts';

export interface ReaderDiagnostics {
  running: boolean;
  updatedAt: number | null;
  sessions: SessionCandidate[];
  windows: WindowCandidate[];
  selection: Selection | null;
  selector: SelectorState;
  invalidPlayers: string[];
  error: string;
}
export interface Reader {
  start(onSnapshot: (s: Snapshot) => void, onError: (message: string) => void): void;
  stop(): Promise<void>;
  diagnostics?(): ReaderDiagnostics;
}
/** MPRIS 播放器 → 选择器使用的会话候选；官方播放器给官方 id，其余标 auto 交给 parseCandidates 折算。 */
export function mprisCandidates(players: MprisPlayer[], savedApps: readonly string[] = []): Record<string, unknown> {
  const saved = new Set(savedApps.map(app => app.toLowerCase()));
  // 保存过的清单外播放器排在前面，避免会话数超过上限时被挤掉。
  const ordered = [...players].sort((a, b) => Number(saved.has(b.app.toLowerCase())) - Number(saved.has(a.app.toLowerCase())));
  const seen = new Set<string>();
  const sessions: Record<string, unknown>[] = [];
  for (const player of ordered) {
    if (!player.title || seen.has(player.app)) continue;
    seen.add(player.app);
    const official = matchPlayer(playerMatchText(player));
    const status = player.status === 'Playing' ? 'playing' : player.status === 'Paused' || player.status === 'Stopped' ? 'paused' : 'unknown';
    sessions.push({
      app: player.app, player: official?.id ?? '', ...(official ? {} : { auto: true }), status,
      title: player.title, artist: player.artist, album: player.album,
      timeline: (player.positionSeconds ?? 0) > 0 || (player.durationSeconds ?? 0) > 0,
      ...(player.positionSeconds !== undefined ? { positionSeconds: player.positionSeconds } : {}),
      ...(player.durationSeconds !== undefined ? { durationSeconds: player.durationSeconds } : {}),
    });
  }
  return { sessions, windowCandidates: [], error: '' };
}

/** Linux 版读取器：每两秒通过 busctl 轮询一次 MPRIS，选择逻辑与原 Windows 版共用。 */
export class MprisReader implements Reader {
  private stopping = true;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private failures = 0;
  private selector = new TrackSelector();
  private running = false;
  private updatedAt = 0;
  private latest: MediaCandidates = { sessions: [], windows: [] };
  private latestSelection: Selection | null = null;
  private latestInvalid: string[] = [];
  private latestError = '';
  private inflight?: Promise<void>;
  constructor(private cfg: MusicConfig, private bus: BusRunner = busctl,
    private timing = { pollMs: 2000, retryMs: 2000 }) {}
  start(onSnapshot: (s: Snapshot) => void, onError: (message: string) => void): void {
    if (!this.stopping) return;
    this.stopping = false;
    this.selector.reset();
    const generation = ++this.generation;
    this.running = true;
    const tick = async () => {
      this.timer = undefined;
      if (this.stopping || generation !== this.generation) return;
      let delay = this.timing.pollMs;
      try {
        const players = await readMprisPlayers(this.bus);
        if (this.stopping || generation !== this.generation) return;
        this.failures = 0;
        this.running = true;
        this.handle(mprisCandidates(players, parseCustomPlayers(this.cfg.customPlayers)), onSnapshot);
      } catch (error) {
        if (this.stopping || generation !== this.generation) return;
        delay = Math.min(60_000, this.timing.retryMs * 2 ** Math.min(this.failures++, 5));
        this.running = false;
        this.latest = { sessions: [], windows: [] };
        this.latestSelection = null;
        this.latestError = error instanceof Error ? error.message : String(error);
        onError(`读取 MPRIS 失败（${this.latestError}），${delay / 1000} 秒后重试`);
      }
      if (!this.stopping && generation === this.generation) this.timer = setTimeout(() => { this.inflight = tick(); }, delay);
    };
    this.inflight = tick();
  }
  private handle(raw: Record<string, unknown>, onSnapshot: (s: Snapshot) => void): void {
    this.updatedAt = Date.now();
    const candidates = parseCandidates(raw);
    this.latest = candidates;
    this.latestError = candidates.error ?? '';
    const saved = customPlayerIds(this.cfg.customPlayers);
    // 保存项的顺序跟设置里的播放器优先级走，不再固定排在官方之后。
    const allowed = new Set([...playerOrder(this.cfg.playerPriority, saved), ...saved]);
    const autoOn = this.cfg.autoDetect !== false;
    // auto:<短名> 是通用识别的正常标识，参与与否由开关和保存项决定，不算「无法识别」。
    this.latestInvalid = [...new Set(
      [...candidates.sessions, ...candidates.windows].map(item => item.player)
        .filter(id => !isAutoPlayer(id) && !allowed.has(id)),
    )];
    this.latestSelection = this.selector.select(this.cfg.playerPriority, candidates.sessions, candidates.windows, {
      enabled: autoOn, blacklist: parseAutoBlacklist(this.cfg.autoBlacklist), saved,
    });
    onSnapshot({ track: this.latestSelection?.track ?? null, error: candidates.error });
  }
  diagnostics(): ReaderDiagnostics {
    return {
      running: this.running,
      updatedAt: this.updatedAt || null,
      sessions: this.latest.sessions,
      windows: this.latest.windows,
      selection: this.latestSelection,
      selector: this.selector.state(),
      invalidPlayers: this.latestInvalid,
      error: this.latestError,
    };
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.latest = { sessions: [], windows: [] };
    this.latestSelection = null;
    this.latestInvalid = [];
    ++this.generation;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.inflight?.catch(() => {});
  }
}
