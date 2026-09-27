import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceShell } from '../src/server/workspace-shell.ts';
import { bwrapAvailable, goAvailable, WorkspaceRunner } from '../src/eval/workspace.ts';

const REPOSITORY = join(import.meta.dirname, '..');
const skip = !(await goAvailable()) ? 'go is not installed, so the runner cannot be built'
  : !(await bwrapAvailable()) ? 'bubblewrap cannot make a sandbox here' : false;

test('the real runner answers inside bubblewrap, laid out as the workspace container', { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'natsumi-sandbox-'));
  try {
    const data = join(root, 'data');
    for (const dir of ['memory/.git', 'work', 'home', 'sources/slack', 'agents']) await mkdir(join(data, dir), { recursive: true });
    await writeFile(join(data, 'memory', 'always.md'), 'FIXTURE-MEMORY\n');
    await writeFile(join(data, 'sources', 'slack', 'INDEX.md'), 'FIXTURE-SOURCES\n');
    await writeFile(join(data, 'agents', 'INDEX.md'), 'FIXTURE-AGENTS\n');
    const manual = join(root, 'manual');
    await mkdir(manual);
    await writeFile(join(manual, 'INDEX.md'), 'FIXTURE-MANUAL\n');
    const runner = await WorkspaceRunner.prepare({ repository: REPOSITORY, cache: join(root, 'cache') });
    const workspace = await runner.start({ data, manual, socketDirectory: join(root, 'socket'), sandbox: 'bwrap', timeZone: 'Asia/Tokyo' });
    try {
      const shell = new WorkspaceShell({ socketPath: workspace.socketPath, timeoutMs: 20_000, timeZone: 'Asia/Tokyo' });
      const read = await shell.run('cat /memory/always.md /sources/slack/INDEX.md /manual/INDEX.md /manual/agents/INDEX.md; pwd; echo $HOME');
      assert.match(read.text, /FIXTURE-MEMORY\nFIXTURE-SOURCES\nFIXTURE-MANUAL\nFIXTURE-AGENTS\n\/work\n\/home\/natsumi/);
      const written = await shell.run('echo kept > /work/out.txt && echo home > /home/natsumi/h.txt && echo mem >> /memory/always.md');
      assert.match(written.text, /終了コード 0/);
      assert.equal(await readFile(join(data, 'work', 'out.txt'), 'utf8'), 'kept\n');
      assert.equal(await readFile(join(data, 'home', 'h.txt'), 'utf8'), 'home\n');
      // What the container keeps read-only stays so.
      for (const place of ['/sources/x', '/manual/x', '/manual/agents/x', '/memory/.git/x', '/usr/x']) {
        const refused = await shell.run(`touch ${place}`);
        assert.doesNotMatch(refused.text, /終了コード 0/, place);
      }
      // No network, and the owner's time zone.
      const offline = await shell.run('cat /sys/class/net/*/operstate 2>/dev/null | grep -c up; date +%Z');
      assert.match(offline.text, /標準出力:\n0\nJST/);
    } finally { await workspace.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
