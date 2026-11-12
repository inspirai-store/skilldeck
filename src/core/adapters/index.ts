import type { Adapter } from './base';
import { claude } from './claude';
import { codex } from './codex';
import { antigravity, codebuddy, copilot, cursor, gemini, kiro, opencode } from './others';

/** Register new agents here; the scanner and UI pick them up without further changes. */
export const ADAPTERS: Adapter[] = [claude, codex, cursor, gemini, opencode, copilot, kiro, codebuddy, antigravity];

export type { Adapter } from './base';
