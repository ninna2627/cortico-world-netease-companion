import { execFile } from 'node:child_process';

/**
 * Linux 版：通过 systemd 自带的 busctl 读写 D-Bus 会话总线上的 MPRIS 播放器。
 * 不依赖原生模块或额外 npm 包，也不需要 playerctl。
 */
export type BusRunner = (args: string[], timeoutMs?: number) => Promise<string>;

export const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const ROOT_IFACE = 'org.mpris.MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

/** 默认的 busctl 调用：会话总线、紧凑 JSON 输出。失败时抛出带 stderr 摘要的错误。 */
export const busctl: BusRunner = (args, timeoutMs = 4000) => new Promise((resolve, reject) => {
  execFile('busctl', ['--user', '--json=short', ...args], { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message).trim().slice(0, 200) || 'busctl 调用失败'));
      resolve(String(stdout));
    });
});

export interface MprisPlayer {
  /** 完整总线名，例如 org.mpris.MediaPlayer2.splayer.instance17268。 */
  bus: string;
  /** 稳定的应用名：DesktopEntry，没有时取总线名去掉前缀和 .instanceNNN。 */
  app: string;
  identity: string;
  desktopEntry: string;
  status: 'Playing' | 'Paused' | 'Stopped' | string;
  title: string;
  artist: string;
  album: string;
  trackId: string;
  positionSeconds?: number;
  durationSeconds?: number;
}

/** busctl --json=short 每个值一行：{"type":"s","data":...}。 */
function parseValues(stdout: string): unknown[] {
  return stdout.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const parsed = JSON.parse(line) as { data?: unknown };
    return parsed?.data;
  });
}
/** a{sv} 里的单个变体值。 */
const variant = (dict: unknown, key: string): unknown => {
  if (!dict || typeof dict !== 'object') return undefined;
  const entry = (dict as Record<string, unknown>)[key];
  return entry && typeof entry === 'object' ? (entry as { data?: unknown }).data : undefined;
};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const textList = (value: unknown): string =>
  (Array.isArray(value) ? value : [value]).map(text).filter(Boolean).join(' / ');
const micros = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value / 1_000_000 : undefined;

/** 总线名 → 应用短名：去掉 MPRIS 前缀与 Chromium/Firefox 式的 .instanceNNN 后缀。 */
export function busApp(bus: string): string {
  return bus.slice(MPRIS_PREFIX.length).replace(/\.instance[\d_]+$/, '') || bus;
}

/** 列出会话总线上所有 MPRIS 播放器的总线名（不含 dev.noctalia.Mpris 这类非标准名）。 */
export async function listMprisNames(run: BusRunner = busctl): Promise<string[]> {
  const [names] = parseValues(await run(['call', 'org.freedesktop.DBus', '/org/freedesktop/DBus',
    'org.freedesktop.DBus', 'ListNames']));
  const list = Array.isArray(names) ? (Array.isArray(names[0]) ? names[0] : names) : [];
  return list.filter((name): name is string => typeof name === 'string' && name.startsWith(MPRIS_PREFIX)).sort();
}

type IdentityCache = Map<string, { identity: string; desktopEntry: string }>;
/** Identity/DesktopEntry 不随曲目变化，按总线名缓存；每个 BusRunner 一份，测试之间互不影响。 */
const identityCaches = new WeakMap<BusRunner, IdentityCache>();
const cacheFor = (run: BusRunner): IdentityCache => {
  let cache = identityCaches.get(run);
  if (!cache) identityCaches.set(run, cache = new Map());
  return cache;
};

/** 读取单个播放器；读不到 Metadata/PlaybackStatus 时抛出。Position 可选，很多播放器不提供。 */
export async function readMprisPlayer(bus: string, run: BusRunner = busctl): Promise<MprisPlayer> {
  const identityCache = cacheFor(run);
  let ident = identityCache.get(bus);
  if (!ident) {
    let identity = '', desktopEntry = '';
    try { [identity] = parseValues(await run(['get-property', bus, OBJECT_PATH, ROOT_IFACE, 'Identity'])).map(text); } catch {}
    try { [desktopEntry] = parseValues(await run(['get-property', bus, OBJECT_PATH, ROOT_IFACE, 'DesktopEntry'])).map(text); } catch {}
    ident = { identity: identity ?? '', desktopEntry: desktopEntry ?? '' };
    identityCache.set(bus, ident);
    if (identityCache.size > 64) identityCache.delete(identityCache.keys().next().value!);
  }
  const [metadata, status] = parseValues(await run(['get-property', bus, OBJECT_PATH, PLAYER_IFACE, 'Metadata', 'PlaybackStatus']));
  let positionSeconds: number | undefined;
  try { positionSeconds = micros(parseValues(await run(['get-property', bus, OBJECT_PATH, PLAYER_IFACE, 'Position']))[0]); } catch {}
  const durationSeconds = micros(variant(metadata, 'mpris:length'));
  return {
    bus,
    app: ident.desktopEntry || busApp(bus),
    identity: ident.identity,
    desktopEntry: ident.desktopEntry,
    status: text(status) || 'Stopped',
    title: text(variant(metadata, 'xesam:title')),
    artist: textList(variant(metadata, 'xesam:artist')),
    album: text(variant(metadata, 'xesam:album')),
    trackId: text(variant(metadata, 'mpris:trackid')),
    ...(positionSeconds !== undefined ? { positionSeconds } : {}),
    ...(durationSeconds !== undefined && durationSeconds > 0 ? { durationSeconds } : {}),
  };
}

/** 读取全部播放器；单个失败不影响其余，最多 16 个。 */
export async function readMprisPlayers(run: BusRunner = busctl): Promise<MprisPlayer[]> {
  const names = (await listMprisNames(run)).slice(0, 16);
  const results = await Promise.all(names.map(name => readMprisPlayer(name, run).catch(() => null)));
  const identityCache = cacheFor(run);
  for (const cached of [...identityCache.keys()]) if (!names.includes(cached)) identityCache.delete(cached);
  return results.filter((item): item is MprisPlayer => item !== null);
}

/** 用于匹配官方播放器的文本：应用名、Identity、DesktopEntry 与总线名。 */
export function playerMatchText(player: Pick<MprisPlayer, 'app' | 'identity' | 'desktopEntry' | 'bus'>): string {
  return [player.app, player.identity, player.desktopEntry, player.bus].filter(Boolean).join(' ');
}

export type MprisMethod = 'Play' | 'Pause' | 'PlayPause' | 'Next' | 'Previous';
export async function callMpris(bus: string, method: MprisMethod, run: BusRunner = busctl): Promise<void> {
  await run(['call', bus, OBJECT_PATH, PLAYER_IFACE, method]);
}
