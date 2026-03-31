import { createInterface } from 'readline';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const STATE_FILE = join(tmpdir(), 'gemini-mcp-guard.json');

function loadState(sessionId) {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    return s.sessionId === sessionId ? s : { sessionId, total: 0, implement: 0 };
  } catch {
    return { sessionId, total: 0, implement: 0 };
  }
}

const lines = [];
const rl = createInterface({ input: process.stdin });
rl.on('line', line => lines.push(line));
rl.on('close', () => {
  try {
    const input = JSON.parse(lines.join('\n'));
    const sessionId = input.session_id ?? 'default';
    const toolName = input.tool_name ?? '';
    const state = loadState(sessionId);
    state.total++;
    if (toolName === 'implement') state.implement++;
    writeFileSync(STATE_FILE, JSON.stringify(state));

    if (state.total >= 3 && state.implement / state.total > 0.30) {
      const pct = ((state.implement / state.total) * 100).toFixed(0);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          additionalContext: `⚠️ implement overuse: ${state.implement}/${state.total} calls (${pct}% > 30%). Prefer graph — it maps the full call chain without reading full source.`
        }
      }));
      process.exit(0);
    }
  } catch {}
  process.stdout.write('{}');
});
