import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/ui',
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist', emptyOutDir: true },
  test: { root: '.', include: ['tests/**/*.test.ts'] },
} as any);
