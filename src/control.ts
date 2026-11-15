import { matchPlayer } from './config.ts';
import { busctl, callMpris, playerMatchText, readMprisPlayer, readMprisPlayers, type BusRunner, type MprisMethod, type MprisPlayer } from './mpris.ts';

export type ControlAction = 'pause' | 'resume' | 'next' | 'prev';

export interface ControlOptions {
  /** 当前曲目的 MPRIS 应用名，作为最后兜底。 */
  match?: string;
  /** 当前播放器 id，便于回执标明来源。 */
  player?: string;
  /** 当前播放器的应用名正则；优先控制这个播放器。 */
  session?: string;
}
export interface ControlResult {
  ok: boolean;
  app?: string;
  player?: string;
  status?: string;
  title?: string;
  artist?: string;
  error?: string;
}

const METHODS: Record<ControlAction, MprisMethod> = { pause: 'Pause', resume: 'Play', next: 'Next', prev: 'Previous' };
const playingFirst = (list: MprisPlayer[]) => list.find(item => item.status === 'Playing') ?? list[0];

/** 选出要控制的 MPRIS 播放器：当前播放器 > 同名应用 > 任一官方播放器。 */
export function pickControlTarget(players: MprisPlayer[], options: ControlOptions): { target?: MprisPlayer; player: string; error?: string } {
  if (options.session) {
    let regex: RegExp;
    try { regex = new RegExp(options.session, 'i'); } catch { return { player: '', error: 'Invalid session regex' }; }
    const current = players.filter(item => regex.test(playerMatchText(item)));
    if (!current.length) return { player: '', error: 'Current player has no controllable media session' };
    return { target: playingFirst(current), player: options.player || 'current' };
  }
  if (options.match) {
    const same = players.filter(item => item.app === options.match);
    if (same.length) return { target: playingFirst(same), player: options.player || 'current' };
  }
  const official = players.filter(item => matchPlayer(playerMatchText(item)) !== null);
  if (official.length) {
    const target = playingFirst(official);
    return { target, player: matchPlayer(playerMatchText(target))!.id };
  }
  return { player: '', error: players.length ? 'No official player session' : 'No controllable media session' };
}

/** 通过 MPRIS 暂停/继续/切歌；失败以结果返回，不抛出。 */
export async function runControl(action: ControlAction, options: ControlOptions = {}, run: BusRunner = busctl,
  settleMs = 400): Promise<ControlResult> {
  try {
    const { target, player, error } = pickControlTarget(await readMprisPlayers(run), options);
    if (!target) return { ok: false, player, error };
    await callMpris(target.bus, METHODS[action], run);
    if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs));
    const after = await readMprisPlayer(target.bus, run).catch(() => target);
    return { ok: true, app: after.app, player, status: after.status, title: after.title, artist: after.artist };
  } catch (error) {
    return { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
  }
}
