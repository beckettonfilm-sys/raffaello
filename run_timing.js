const { performance } = require('perf_hooks');

class RunTiming {
  constructor() { this.startedAt = performance.now(); this.phases = {}; this.active = new Map(); this.counters = {}; }
  start(name) { if (!name || this.active.has(name)) return; this.active.set(name, performance.now()); }
  end(name) { if (!name) return 0; const s = this.active.get(name); if (s === undefined) return 0; this.active.delete(name); const ms = performance.now() - s; this.phases[name] = (this.phases[name] || 0) + ms; return ms; }
  measure(name, fn) { this.start(name); return Promise.resolve().then(fn).finally(() => this.end(name)); }
  add(name, ms) { this.phases[name] = (this.phases[name] || 0) + Math.max(0, Number(ms) || 0); }
  count(name, ms) { const c = this.counters[name] || { count: 0, totalMs: 0, minMs: null, maxMs: null }; c.count += 1; c.totalMs += Math.max(0, Number(ms) || 0); c.minMs = c.minMs === null ? ms : Math.min(c.minMs, ms); c.maxMs = c.maxMs === null ? ms : Math.max(c.maxMs, ms); c.avgMs = c.count ? c.totalMs / c.count : 0; this.counters[name] = c; }
  snapshot() { const totalMs = performance.now() - this.startedAt; return { totalMs, activeProgramMs: totalMs - (this.phases.user_wait_json || 0), userWaitMs: this.phases.user_wait_json || 0, phases: { ...this.phases }, counters: { ...this.counters } }; }
}
module.exports = { RunTiming };
