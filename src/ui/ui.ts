// STUB — owned by the UI agent.
import type { Bus, Ctx } from '../game/context';
import type { Action } from '../game/types';
export interface SessionLike { act(a: Action): void; isHost(): boolean }
export class UI {
  constructor(readonly bus: Bus) {}
  /** Title screen; resolves when the player presses Play (online) or Solo (offline). */
  showTitle(_opts: { invite: boolean }): Promise<{ mode: 'online' | 'offline'; name: string }> { return new Promise(() => {}); }
  /** Loading progress 0..1 shown on the title screen; the Play buttons enable at 1. */
  setLoading(_fraction: number, _label: string) {}
  toast(_msg: string) {}
  /** Called once connected: creates HUD, lobby/briefing, end screens, pause menu, touch controls. */
  attach(_ctx: Ctx, _session: SessionLike) {}
  update(_dt: number) {}
}
