// Networking facade. `PlayroomNet` (online, Playroom Kit) and `LocalNet` (offline solo) expose the
// same `Net` interface so no other module ever imports playroomkit directly.
//
// Keys used in Playroom state (see types.ts):
//   player 'p'  PlayerNet, unreliable   player 'nm' display name, reliable
//   room   'w'  WorldState, reliable     room   'g'  ActorsNet, unreliable
// RPCs: 'act' (client -> host, validated by the host), 'fx' (host -> everyone).
import type { Action, ActorsNet, Fx, PlayerNet, WorldState } from './types';

export interface NetPlayer {
  id: string;
  /** display name: the name typed in the lobby, else the Playroom profile name */
  name: string;
  /** css colour from the Playroom profile (used for name tags / map markers) */
  color: string;
  isMe: boolean;
}

export interface Net {
  readonly mode: 'online' | 'offline';
  readonly myId: string;
  isHost(): boolean;
  roomCode(): string | undefined;
  /** shareable URL that joins this room */
  inviteUrl(): string;
  /** all connected players including me, in join order */
  players(): NetPlayer[];
  onJoin(cb: (p: NetPlayer) => void): void;
  onQuit(cb: (id: string) => void): void;

  setMyName(name: string): void;
  setMyState(s: PlayerNet): void;
  getPlayerState(id: string): PlayerNet | null;

  getWorld(): WorldState | null;
  /** host only */
  setWorld(w: WorldState): void;
  getActors(): ActorsNet | null;
  /** host only */
  setActors(a: ActorsNet): void;

  /** send a request to the host (applied locally when I am the host) */
  act(a: Action): void;
  /** host-side handler for requests (registered on every client; only invoked while host) */
  onAction(cb: (a: Action, from: string) => void): void;
  /** host -> everyone (including the host itself) */
  fx(f: Fx): void;
  onFx(cb: (f: Fx) => void): void;
  /** host only: pass the host role to another connected player; false if there is nobody */
  handOffHost(): boolean;
}

const NAME_KEY = 'fogbreak.name';
export function savedName(): string {
  try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; }
}
export function saveName(name: string) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* private mode */ }
}

// ------------------------------------------------------------------------------------------------
// Offline: one local player who is always the host.
// ------------------------------------------------------------------------------------------------
export class LocalNet implements Net {
  readonly mode = 'offline' as const;
  readonly myId = 'local';
  private name = savedName() || 'Player';
  private state: PlayerNet | null = null;
  private world: WorldState | null = null;
  private actors: ActorsNet | null = null;
  private readonly actionCbs: ((a: Action, from: string) => void)[] = [];
  private readonly fxCbs: ((f: Fx) => void)[] = [];

  isHost() { return true; }
  roomCode() { return undefined; }
  inviteUrl() { return location.href.split('#')[0]; }
  players(): NetPlayer[] { return [{ id: this.myId, name: this.name, color: '#e8c25a', isMe: true }]; }
  onJoin(cb: (p: NetPlayer) => void) { queueMicrotask(() => cb(this.players()[0])); }
  onQuit() { /* nobody leaves */ }
  setMyName(name: string) { this.name = name; saveName(name); }
  setMyState(s: PlayerNet) { this.state = s; }
  getPlayerState(id: string) { return id === this.myId ? this.state : null; }
  getWorld() { return this.world; }
  setWorld(w: WorldState) { this.world = w; }
  getActors() { return this.actors; }
  setActors(a: ActorsNet) { this.actors = a; }
  act(a: Action) { queueMicrotask(() => { for (const cb of this.actionCbs) cb(a, this.myId); }); }
  onAction(cb: (a: Action, from: string) => void) { this.actionCbs.push(cb); }
  fx(f: Fx) { for (const cb of this.fxCbs) cb(f); }
  onFx(cb: (f: Fx) => void) { this.fxCbs.push(cb); }
  handOffHost() { return false; }
}

// ------------------------------------------------------------------------------------------------
// Online: Playroom Kit. Loaded lazily so offline play never downloads it.
// ------------------------------------------------------------------------------------------------
type PK = typeof import('playroomkit');
type PKPlayer = ReturnType<PK['myPlayer']>;

export class PlayroomNet implements Net {
  readonly mode = 'online' as const;
  myId = '';
  private pk!: PK;
  private readonly roster = new Map<string, PKPlayer>();
  private readonly joinCbs: ((p: NetPlayer) => void)[] = [];
  private readonly quitCbs: ((id: string) => void)[] = [];
  private readonly actionCbs: ((a: Action, from: string) => void)[] = [];
  private readonly fxCbs: ((f: Fx) => void)[] = [];

  /** Joins the room in the URL hash (#r=CODE) or creates a new one. Throws on network failure. */
  static async connect(): Promise<PlayroomNet> {
    const net = new PlayroomNet();
    net.pk = await import('playroomkit');
    const gameId = (import.meta.env.VITE_PLAYROOM_GAME_ID as string | undefined) || undefined;
    await net.pk.insertCoin({ gameId, skipLobby: true, maxPlayersPerRoom: 4, reconnectGracePeriod: 15000 });
    net.myId = net.pk.myPlayer().id;
    const name = savedName();
    if (name) net.pk.myPlayer().setState('nm', name, true);

    net.pk.onPlayerJoin((p) => {
      net.roster.set(p.id, p);
      const np = net.toNetPlayer(p);
      for (const cb of net.joinCbs) cb(np);
      p.onQuit(() => {
        net.roster.delete(p.id);
        for (const cb of net.quitCbs) cb(p.id);
      });
    });
    net.pk.RPC.register('act', async (payload: Action, sender) => {
      if (!net.pk.isHost()) return;
      for (const cb of net.actionCbs) cb(payload, sender.id);
    });
    net.pk.RPC.register('fx', async (payload: Fx) => {
      for (const cb of net.fxCbs) cb(payload);
    });
    return net;
  }

  private toNetPlayer(p: PKPlayer): NetPlayer {
    const profile = p.getProfile();
    return {
      id: p.id,
      name: (p.getState('nm') as string | undefined) || profile?.name || 'Inmate',
      color: profile?.color?.hexString ?? '#e8c25a',
      isMe: p.id === this.myId,
    };
  }

  isHost() { return this.pk.isHost(); }
  roomCode() { return this.pk.getRoomCode(); }
  inviteUrl() {
    // Playroom writes the room into the hash itself (e.g. #r=RABCD); fall back to building it.
    if (/[#&]r=/.test(location.hash)) return location.href;
    const code = this.roomCode();
    return `${location.origin}${location.pathname}${code ? `#r=R${code}` : ''}`;
  }
  players() { return [...this.roster.values()].map((p) => this.toNetPlayer(p)); }
  onJoin(cb: (p: NetPlayer) => void) {
    this.joinCbs.push(cb);
    for (const p of this.roster.values()) cb(this.toNetPlayer(p)); // replay players already here
  }
  onQuit(cb: (id: string) => void) { this.quitCbs.push(cb); }
  setMyName(name: string) { saveName(name); this.pk.myPlayer().setState('nm', name, true); }
  setMyState(s: PlayerNet) { this.pk.myPlayer().setState('p', s, false); }
  getPlayerState(id: string) { return (this.roster.get(id)?.getState('p') as PlayerNet | undefined) ?? null; }
  getWorld() { return (this.pk.getState('w') as WorldState | undefined) ?? null; }
  setWorld(w: WorldState) { this.pk.setState('w', w, true); }
  getActors() { return (this.pk.getState('g') as ActorsNet | undefined) ?? null; }
  setActors(a: ActorsNet) { this.pk.setState('g', a, false); }
  act(a: Action) {
    if (this.pk.isHost()) {
      queueMicrotask(() => { for (const cb of this.actionCbs) cb(a, this.myId); });
    } else {
      void this.pk.RPC.call('act', a, this.pk.RPC.Mode.HOST);
    }
  }
  onAction(cb: (a: Action, from: string) => void) { this.actionCbs.push(cb); }
  fx(f: Fx) {
    for (const cb of this.fxCbs) cb(f);
    void this.pk.RPC.call('fx', f, this.pk.RPC.Mode.OTHERS);
  }
  onFx(cb: (f: Fx) => void) { this.fxCbs.push(cb); }
  handOffHost() {
    if (!this.pk.isHost()) return false;
    const other = [...this.roster.keys()].find((id) => id !== this.myId);
    if (!other) return false;
    void this.pk.transferHost(other);
    return true;
  }
}
