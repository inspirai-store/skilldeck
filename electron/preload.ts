import { contextBridge, ipcRenderer } from 'electron';

/** Transport only; no filesystem or arbitrary Electron APIs exposed to the renderer. */
contextBridge.exposeInMainWorld('skilldeck', Object.freeze({
  call: (method: string, params: unknown = {}) => ipcRenderer.invoke('skilldeck:rpc', method, params),
}));
