import { posix } from 'node:path';
import { createReadToolDefinition, defineTool, type ReadOperations } from '@earendil-works/pi-coding-agent';
import { READ_DESCRIPTION } from './prompts.ts';
import type { Capture } from './workspace-shell.ts';

/**
 * Pi's built-in `read`, pointed at the workspace (ADR 0047). What it reads comes through the runner, the same way in
 * as `run_shell`, so it can reach nothing her shell cannot: the server's own files stay out of sight. It is limited to
 * /manual and /memory not for safety but for meaning — what is read with it is kept when a turn is folded, and those
 * are the two places worth keeping. With skills on, the owner's skills in /skills are a third (ADR 0073).
 */

/** The most lines one read returns. `READ_DESCRIPTION` states it; Pi's own 50KB limit on a result stays as it is. */
export const READ_MAX_LINES = 400;
/** The largest file read at all. A memory file is far smaller (ADR 0020); anything past this is read in part with run_shell. */
export const READ_MAX_FILE_BYTES = 256 * 1024;
/** Bytes per piece: base64 makes it 60 KiB, inside the runner's 64 KiB answer. */
const PIECE_BYTES = 45 * 1024;
/** The workspace's working directory, which a relative path is taken from. */
const WORK = '/work';
const PLACES = ['/manual/', '/memory/'];
/** With skills on, the owner's clone too (ADR 0073): the list in her instructions names each SKILL.md there. */
const SKILL_PLACES = [...PLACES, '/skills/'];
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i;

const OUTSIDE = (path: string, skills: boolean) => `読んでいません（${path}）。read で読めるのは ${skills ? '/manual・/memory・/skills' : '/manual と /memory'} の下のファイルだけです。ほかの場所は run_shell で読んでください。`;
const NOT_TEXT = (path: string) => `読んでいません（${path}）。画像やバイナリのファイルは read で読めません。画像は run_shell の view で見てください。`;

/** Runs one command in the workspace and hands back its output. */
export type RunnerCapture = (command: string) => Promise<Capture>;

export function workspaceReadTool(capture: RunnerCapture, options: { skills?: boolean } = {}) {
  const skills = options.skills === true;
  const places = skills ? SKILL_PLACES : PLACES;
  const base = createReadToolDefinition(WORK, { operations: operations(capture, places, skills) });
  // Pi's own definition, less its terminal renderers, prompt snippet and guideline, with natsumi's description. Pi's
  // guideline says to read any file with it, which this read does not; since Pi 1.0.4 Codemode puts each tool's
  // guidelines into its declarations, which the prefix test holds (ADR 0047, ADR 0066).
  return defineTool({
    name: base.name, label: base.label, description: READ_DESCRIPTION, parameters: base.parameters,
    execute: (id, params, signal, onUpdate, ctx) => {
      // Taken from the workspace's working directory rather than the server's, which Pi would otherwise use.
      const path = posix.resolve(WORK, params.path);
      if (!inside(path, places)) return Promise.reject(new Error(OUTSIDE(params.path, skills)));
      const limit = Math.min(params.limit ?? READ_MAX_LINES, READ_MAX_LINES);
      return base.execute(id, { ...params, path, limit }, signal, onUpdate, ctx);
    },
  });
}

function inside(path: string, places: readonly string[]): boolean {
  return !path.includes('\u0000') && posix.normalize(path) === path && places.some(place => path.startsWith(place) && path.length > place.length);
}

function operations(capture: RunnerCapture, places: readonly string[], skills: boolean): ReadOperations {
  const run = async (command: string) => {
    const answer = await capture(command);
    if (!answer.ok) throw new Error(`読めませんでした。${answer.text}`);
    return answer;
  };
  return {
    async access(path) {
      if (!inside(path, places)) throw new Error(OUTSIDE(path, skills));
      if (IMAGE.test(path)) throw new Error(NOT_TEXT(path));
      const answer = await run(`test -f ${quote(path)} && test -r ${quote(path)}`);
      if (answer.exitCode !== 0) throw new Error(`読んでいません（${path}）。ファイルが見つかりません。ls で名前を確かめてください。`);
    },
    async readFile(path) {
      const size = Number((await run(`wc -c < ${quote(path)}`)).stdout.trim());
      if (!Number.isFinite(size)) throw new Error(`読めませんでした（${path}）。`);
      if (size > READ_MAX_FILE_BYTES) {
        throw new Error(`読んでいません（${path}）。ファイルが大きすぎます（${READ_MAX_FILE_BYTES / 1024}KB まで）。run_shell で head や sed -n、rg で必要なところだけを読んでください。`);
      }
      // In pieces of raw bytes, carried as base64 so a piece may end inside a character.
      const pieces: Buffer[] = [];
      for (let offset = 0; offset < size || pieces.length === 0; offset += PIECE_BYTES) {
        const answer = await run(`tail -c +${offset + 1} -- ${quote(path)} | head -c ${PIECE_BYTES} | base64 -w0`);
        if (answer.exitCode !== 0 || answer.stdoutTruncated) throw new Error(`読めませんでした（${path}）。`);
        const piece = Buffer.from(answer.stdout.trim(), 'base64');
        pieces.push(piece);
        if (piece.length < PIECE_BYTES) break;
      }
      const buffer = Buffer.concat(pieces);
      if (buffer.includes(0)) throw new Error(NOT_TEXT(path));
      return buffer;
    },
    // Nothing is ever sent as an image: a picture is looked at with `view` (ADR 0039), and kept nowhere.
    detectImageMimeType: async () => null,
  };
}

/** One argument for bash, in single quotes. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
