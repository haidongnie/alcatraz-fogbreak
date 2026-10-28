// A* over the cellhouse waypoint graph (layout NAV_NODES / NAV_EDGES, floor level). The graph has
// ~20 nodes, so a linear scan of the open set beats a heap. All buffers are preallocated; queries
// write into caller-provided arrays and never allocate.
import type * as THREE from 'three/webgpu';
import { NAV_EDGES, NAV_NODES } from '../../world/layout';

export class NavGraph {
  readonly count: number;
  readonly ids: string[];
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  /** adjacency as a flat list: neighbours of i are adj[adjStart[i] .. adjStart[i + 1]) */
  private readonly adj: Int16Array;
  private readonly adjStart: Int16Array;
  private readonly edgeA: Int16Array;
  private readonly edgeB: Int16Array;
  private readonly g: Float32Array;
  private readonly f: Float32Array;
  private readonly came: Int16Array;
  /** 0 = unvisited, 1 = open, 2 = closed */
  private readonly state: Uint8Array;

  constructor() {
    this.ids = Object.keys(NAV_NODES);
    const n = (this.count = this.ids.length);
    const index = new Map(this.ids.map((id, i) => [id, i]));
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    this.ids.forEach((id, i) => {
      const p = NAV_NODES[id];
      this.x[i] = p[0]; this.y[i] = p[1]; this.z[i] = p[2];
    });
    const lists: number[][] = this.ids.map(() => []);
    const ea: number[] = [], eb: number[] = [];
    for (const [a, b] of NAV_EDGES) {
      const ia = index.get(a), ib = index.get(b);
      if (ia === undefined || ib === undefined) { console.warn(`[nav] edge ${a}-${b} references a missing node`); continue; }
      lists[ia].push(ib);
      lists[ib].push(ia);
      ea.push(ia); eb.push(ib);
    }
    this.adjStart = new Int16Array(n + 1);
    const flat: number[] = [];
    for (let i = 0; i < n; i++) { this.adjStart[i] = flat.length; flat.push(...lists[i]); }
    this.adjStart[n] = flat.length;
    this.adj = Int16Array.from(flat);
    this.edgeA = Int16Array.from(ea);
    this.edgeB = Int16Array.from(eb);
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.came = new Int16Array(n);
    this.state = new Uint8Array(n);
  }

  private dist(a: number, b: number) { return Math.hypot(this.x[a] - this.x[b], this.z[a] - this.z[b]); }
  private d2(i: number, x: number, z: number) { return (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2; }

  /** The `k` nodes closest to (x, z) in the horizontal plane, nearest first. Returns how many were written. */
  nearest(x: number, z: number, k: number, out: Int16Array): number {
    const m = Math.min(k, out.length, this.count);
    let filled = 0;
    // insertion into a small sorted buffer (tiny graph: recomputing distances is cheaper than caching)
    for (let i = 0; i < this.count; i++) {
      const d = this.d2(i, x, z);
      if (filled === m && d >= this.d2(out[m - 1], x, z)) continue;
      let j = filled < m ? filled++ : m - 1;
      while (j > 0 && this.d2(out[j - 1], x, z) > d) { out[j] = out[j - 1]; j--; }
      out[j] = i;
    }
    return filled;
  }

  /** A* from node a to node b. Writes node indices a..b into `out`; returns the length (0 = no path). */
  find(a: number, b: number, out: Int16Array): number {
    const n = this.count;
    const { g, f, came, state } = this;
    g.fill(Infinity); f.fill(Infinity); came.fill(-1); state.fill(0);
    g[a] = 0; f[a] = this.dist(a, b); state[a] = 1;
    for (;;) {
      let cur = -1, best = Infinity;
      for (let i = 0; i < n; i++) if (state[i] === 1 && f[i] < best) { best = f[i]; cur = i; }
      if (cur < 0) return 0;
      if (cur === b) break;
      state[cur] = 2;
      for (let e = this.adjStart[cur]; e < this.adjStart[cur + 1]; e++) {
        const nb = this.adj[e];
        if (state[nb] === 2) continue;
        const ng = g[cur] + this.dist(cur, nb);
        if (ng < g[nb]) { g[nb] = ng; f[nb] = ng + this.dist(nb, b); came[nb] = cur; state[nb] = 1; }
      }
    }
    let len = 0;
    for (let c = b; c >= 0 && len < out.length; c = came[c]) out[len++] = c;
    for (let i = 0, j = len - 1; i < j; i++, j--) { const t = out[i]; out[i] = out[j]; out[j] = t; }
    return len;
  }

  /** Closest point (floor level) on any graph edge to (x, z): "the aisle right in front of it". */
  closestOnEdges(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    let best = Infinity;
    for (let e = 0; e < this.edgeA.length; e++) {
      const a = this.edgeA[e], b = this.edgeB[e];
      const ax = this.x[a], az = this.z[a];
      const vx = this.x[b] - ax, vz = this.z[b] - az;
      const l2 = vx * vx + vz * vz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2)) : 0;
      const px = ax + vx * t, pz = az + vz * t;
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < best) { best = d; out.set(px, this.y[a] + (this.y[b] - this.y[a]) * t, pz); }
    }
    return out;
  }
}
