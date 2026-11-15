import test from 'node:test';
import assert from 'node:assert/strict';
import { MprisReader, mprisCandidates } from '../src/reader.ts';
import { pickControlTarget, runControl } from '../src/control.ts';
import { busApp, type BusRunner, type MprisPlayer } from '../src/mpris.ts';
import { defaults } from '../src/config.ts';
import definition from '../src/index.ts';

interface FakePlayer { identity?: string; desktop?: string; status?: string; title?: string; artist?: string[];
  album?: string; length?: number; position?: number }
const v = (type: string, data: unknown) => JSON.stringify({ type, data });
/** 模拟 busctl --user --json=short 的输出；players 可在测试中途修改。 */
function fakeBus(players: Record<string, FakePlayer>, calls: string[][] = []): BusRunner {
  return async args => {
    calls.push(args);
    if (args[0] === 'call' && args[4] === 'ListNames')
      return v('as', [['org.freedesktop.DBus', ':1.1', 'dev.noctalia.Mpris', ...Object.keys(players)]]) + '\n';
    if (args[0] === 'call') { if (!players[args[1]]) throw new Error('no such name'); return ''; }
    const p = players[args[1]];
    if (!p) throw new Error('no such name');
    const props = args.slice(4);
    return props.map(prop => {
      switch (prop) {
        case 'Identity': return v('s', p.identity ?? '');
        case 'DesktopEntry': if (!p.desktop) throw new Error('unknown property'); return v('s', p.desktop);
        case 'PlaybackStatus': return v('s', p.status ?? 'Playing');
        case 'Position': if (p.position === undefined) throw new Error('unknown property'); return v('x', p.position);
        case 'Metadata': return v('a{sv}', {
          'mpris:trackid': { type: 'o', data: '/com/splayer/track/1' },
          'xesam:title': { type: 's', data: p.title ?? '' },
          'xesam:artist': { type: 'as', data: p.artist ?? [''] },
          'xesam:album': { type: 's', data: p.album ?? '' },
          ...(p.length ? { 'mpris:length': { type: 'x', data: p.length } } : {}),
        });
        default: throw new Error(`unexpected ${prop}`);
      }
    }).join('\n') + '\n';
  };
}
const SPLAYER = 'org.mpris.MediaPlayer2.splayer.instance17268';
const FIREFOX = 'org.mpris.MediaPlayer2.firefox.instance_1_47';
const splayer = (extra: FakePlayer = {}): FakePlayer => ({ identity: 'SPlayer', desktop: 'SPlayer', status: 'Playing',
  title: '晴天', artist: ['周杰伦'], album: '叶惠美', length: 269_000_000, position: 12_500_000, ...extra });
const firefox = (extra: FakePlayer = {}): FakePlayer => ({ identity: 'Mozilla firefox', desktop: 'firefox', status: 'Playing',
  title: 'B 站视频', ...extra });
const fast = { pollMs: 10, retryMs: 10 };
const wait = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

test('busApp 去掉 MPRIS 前缀与实例后缀', () => {
  assert.equal(busApp(SPLAYER), 'splayer');
  assert.equal(busApp(FIREFOX), 'firefox');
  assert.equal(busApp('org.mpris.MediaPlayer2.mpv'), 'mpv');
});

test('读取器把 SPlayer 识别为官方播放器，并换算进度与时长', async () => {
  const snapshots: any[] = [];
  const reader = new MprisReader(defaults(), fakeBus({ [SPLAYER]: splayer() }), fast);
  reader.start(snapshot => snapshots.push(snapshot), () => {});
  await wait();
  await reader.stop();
  const track = snapshots.at(-1)?.track;
  assert.equal(track?.player, 'netease');
  assert.equal(track?.app, 'SPlayer');
  assert.equal(track?.title, '晴天');
  assert.equal(track?.artist, '周杰伦');
  assert.equal(track?.status, 'playing');
  assert.equal(track?.method, 'smtc');
  assert.equal(track?.timeline, true);
  assert.equal(track?.positionSeconds, 12.5);
  assert.equal(track?.durationSeconds, 269);
  assert.equal(reader.diagnostics().running, false);
});

test('读取器：没有 DesktopEntry 时按总线名匹配，Stopped 视为暂停', async () => {
  const snapshots: any[] = [];
  const reader = new MprisReader(defaults(),
    fakeBus({ [SPLAYER]: splayer({ desktop: undefined, identity: '', status: 'Stopped', position: undefined }) }), fast);
  reader.start(snapshot => snapshots.push(snapshot), () => {});
  await wait();
  const diagnostics = reader.diagnostics();
  await reader.stop();
  assert.equal(snapshots.at(-1)?.track?.player, 'netease');
  assert.equal(snapshots.at(-1)?.track?.app, 'splayer');
  assert.equal(snapshots.at(-1)?.track?.status, 'paused');
  assert.equal(diagnostics.sessions[0].positionSeconds, undefined);
  assert.equal(diagnostics.sessions[0].durationSeconds, 269);
});

test('读取器：Firefox 默认只出现在诊断里，开启通用识别或保存后才参与', async () => {
  const run = async (cfg: any) => {
    const snapshots: any[] = [];
    const reader = new MprisReader(cfg, fakeBus({ [FIREFOX]: firefox() }), fast);
    reader.start(snapshot => snapshots.push(snapshot), () => {});
    await wait();
    const result = { track: snapshots.at(-1)?.track, invalid: reader.diagnostics().invalidPlayers,
      sessions: reader.diagnostics().sessions.map(item => item.player) };
    await reader.stop();
    return result;
  };
  const off = await run(defaults());
  assert.equal(off.track, null);
  assert.deepEqual(off.invalid, []);
  assert.deepEqual(off.sessions, ['auto:firefox']);
  assert.equal((await run({ ...defaults(), autoDetect: true })).track?.player, 'auto:firefox');
  assert.equal((await run({ ...defaults(), customPlayers: ['firefox'] })).track?.player, 'auto:firefox');
});

test('读取器：SPlayer 在播时优先于开启了通用识别的 Firefox', async () => {
  const snapshots: any[] = [];
  const reader = new MprisReader({ ...defaults(), autoDetect: true },
    fakeBus({ [FIREFOX]: firefox(), [SPLAYER]: splayer() }), fast);
  reader.start(snapshot => snapshots.push(snapshot), () => {});
  await wait();
  await reader.stop();
  assert.equal(snapshots.at(-1)?.track?.player, 'netease');
});

test('读取器：busctl 失败时报告错误并重试，恢复后继续上报', async () => {
  let broken = true;
  const ok = fakeBus({ [SPLAYER]: splayer() });
  const bus: BusRunner = async (args, timeout) => { if (broken) throw new Error('总线不可用'); return ok(args, timeout); };
  const errors: string[] = [];
  const snapshots: any[] = [];
  const reader = new MprisReader(defaults(), bus, fast);
  reader.start(snapshot => snapshots.push(snapshot), message => errors.push(message));
  await wait(30);
  assert.match(errors[0], /总线不可用/);
  assert.equal(reader.diagnostics().running, false);
  broken = false;
  await wait(200);
  await reader.stop();
  assert.equal(snapshots.at(-1)?.track?.player, 'netease');
});

test('mprisCandidates 跳过无标题会话并把保存项排前', () => {
  const base: MprisPlayer = { bus: SPLAYER, app: 'SPlayer', identity: 'SPlayer', desktopEntry: 'SPlayer', status: 'Playing',
    title: '晴天', artist: '周杰伦', album: '', trackId: '' };
  const raw = mprisCandidates([
    base,
    { ...base, bus: FIREFOX, app: 'firefox', identity: 'Mozilla firefox', desktopEntry: 'firefox' },
    { ...base, bus: 'org.mpris.MediaPlayer2.mpv', app: 'mpv', identity: 'mpv', desktopEntry: '', title: '' },
  ], ['firefox']) as any;
  assert.deepEqual(raw.sessions.map((item: any) => item.app), ['firefox', 'SPlayer']);
  assert.equal(raw.sessions[0].auto, true);
  assert.equal(raw.sessions[1].player, 'netease');
});

test('播放控制：优先当前播放器，调用对应的 MPRIS 方法', async () => {
  const calls: string[][] = [];
  const bus = fakeBus({ [FIREFOX]: firefox(), [SPLAYER]: splayer() }, calls);
  const result = await runControl('pause', { session: 'splayer', player: 'netease', match: 'SPlayer' }, bus, 0);
  assert.equal(result.ok, true);
  assert.equal(result.player, 'netease');
  assert.equal(result.title, '晴天');
  const methodCalls = calls.filter(args => args[0] === 'call' && args[1] !== 'org.freedesktop.DBus');
  assert.deepEqual(methodCalls, [['call', SPLAYER, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', 'Pause']]);
  for (const [action, method] of [['resume', 'Play'], ['next', 'Next'], ['prev', 'Previous']] as const) {
    const seen: string[][] = [];
    await runControl(action, { session: 'splayer' }, fakeBus({ [SPLAYER]: splayer() }, seen), 0);
    assert.equal(seen.find(args => args[0] === 'call' && args[1] === SPLAYER)?.[4], method);
  }
});

test('播放控制：当前播放器没有会话时不去控制别的软件', async () => {
  const calls: string[][] = [];
  const result = await runControl('next', { session: 'splayer', player: 'netease' }, fakeBus({ [FIREFOX]: firefox() }, calls), 0);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /no controllable/i);
  assert.equal(calls.some(args => args[0] === 'call' && args[1] === FIREFOX), false);
  // 没有当前播放器时只兜底到官方播放器，不碰 Firefox。
  assert.equal(pickControlTarget([{ bus: FIREFOX, app: 'firefox', identity: 'Mozilla firefox', desktopEntry: 'firefox',
    status: 'Playing', title: 'x', artist: '', album: '', trackId: '' }], {}).target, undefined);
});

test('preflight 归一化播放器优先级并补齐官方项', () => {
  const patches: any[] = [];
  definition.preflight!({
    cfg: { ...defaults(), playerPriority: ['unknown', 'netease', 'netease'] },
    persist: (patch: any) => patches.push(patch),
  } as any);
  assert.deepEqual(patches, [{ playerPriority: ['netease'] }]);
  const explicit: any[] = [];
  definition.preflight!({ cfg: defaults(), persist: (patch: any) => explicit.push(patch) } as any);
  assert.deepEqual(explicit, []);
  // 已保存项留在原位置，官方缺项补齐；取消保存后从优先级里清掉。
  const withCustom: any[] = [];
  definition.preflight!({
    cfg: { ...defaults(), playerPriority: ['netease', 'auto:vutronmusic'], customPlayers: ['VutronMusic.exe'] },
    persist: (patch: any) => withCustom.push(patch),
  } as any);
  // 只有一个官方播放器时这份顺序已经是规范形式，不需要回写。
  assert.deepEqual(withCustom, []);
  const removed: any[] = [];
  definition.preflight!({
    cfg: { ...defaults(), playerPriority: ['netease', 'auto:vutronmusic'], customPlayers: [] },
    persist: (patch: any) => removed.push(patch),
  } as any);
  assert.deepEqual(removed, [{ playerPriority: ['netease'] }]);
  // 旧配置没有 autoDetect 时按新默认（关闭）补齐；已有显式值不改。
  const legacy: any[] = [];
  definition.preflight!({ cfg: { ...defaults(), autoDetect: undefined }, persist: (patch: any) => legacy.push(patch) } as any);
  assert.deepEqual(legacy, [{ autoDetect: false }]);
  const explicitOff: any[] = [];
  definition.preflight!({ cfg: { ...defaults(), autoDetect: true }, persist: (patch: any) => explicitOff.push(patch) } as any);
  assert.deepEqual(explicitOff, []);
});
