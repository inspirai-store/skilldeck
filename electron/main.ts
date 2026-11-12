import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Engine } from '../src/core/engine';
import { dispatch } from '../src/core/api';
import { defaultCtx } from '../src/core/util';

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(() => {
  const engine = new Engine(defaultCtx());
  const index = path.join(__dirname, '..', 'dist', 'index.html');
  const window = new BrowserWindow({
    width: 1360, height: 860, minWidth: 980, minHeight: 600, title: 'SkillDeck', show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161617' : '#f4f3f0',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } } : { autoHideMenuBar: true }),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  ipcMain.handle('skilldeck:rpc', (event, method: string, params: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(index).href) throw new Error('Untrusted IPC sender');
    return dispatch(engine, method, params);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  void window.loadFile(index);
});
app.on('window-all-closed', () => app.quit());
