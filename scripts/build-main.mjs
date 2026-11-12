import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', mainFields: ['module', 'main'], target: 'node20', format: 'cjs', external: ['electron'], logLevel: 'info' };
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' });
await build({ ...common, entryPoints: ['electron/server.ts'], outfile: 'dist-electron/server.cjs' });
