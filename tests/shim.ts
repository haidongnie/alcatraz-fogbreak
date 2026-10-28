// Minimal browser globals so modules that read location/matchMedia at import time load in Node.
const g = globalThis as Record<string, unknown>;
g.location = { search: '', hash: '', href: 'http://localhost/', origin: 'http://localhost', pathname: '/' };
g.matchMedia = () => ({ matches: false });
if (!('navigator' in g)) g.navigator = { userAgent: 'node', language: 'en' };
export {};
