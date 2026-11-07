import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface FakeTraeOptions {
  version?: string;
  unsupportedExec?: boolean;
  events?: unknown[];
  exitCode?: number;
  hang?: boolean;
  ignoreTerm?: boolean;
  stderr?: string;
  history?: unknown;
  historyError?: boolean;
  initError?: boolean;
}

/** A process fixture that rejects history requests sent before initialization. */
export async function writeFakeTrae(root: string, options: FakeTraeOptions = {}) {
  const scriptPath = join(root, 'traecli.cjs');
  const binary = process.platform === 'win32' ? join(root, 'traecli.CMD') : scriptPath;
  const recordPath = join(root, 'trae-record.json');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const options = ${JSON.stringify(options)};
const args = process.argv.slice(2);
const record = { argv: args, stdin: '', requests: [], env: {
  TRAE_HOME: process.env.TRAE_HOME, TRAECLI_HOME: process.env.TRAECLI_HOME,
  CODEX_HOME: process.env.CODEX_HOME, LARK_CHANNEL: process.env.LARK_CHANNEL,
  LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,
  LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,
} };
const persist = () => fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(record));
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (args.includes('--version')) {
  console.log(options.version || 'traecli 0.212.1');
} else if (args.includes('--help')) {
  console.log(options.unsupportedExec ? 'Legacy command' : 'TRAE exec --json; prompt from stdin');
} else if (args[0] === 'app-server') {
  let acknowledged = false;
  let initialized = false;
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const req = JSON.parse(line);
    record.requests.push(req);
    persist();
    if (req.method === 'initialize') {
      setTimeout(() => {
        acknowledged = true;
        send(options.initError ? { id: req.id, error: { message: 'init rejected' } } : { id: req.id, result: { userAgent: 'fake-trae' } });
      }, 15);
    } else if (req.method === 'initialized') {
      initialized = acknowledged;
    } else if (req.method === 'thread/list') {
      if (!initialized || options.historyError) send({ id: req.id, error: { message: 'history unavailable or premature request' } });
      else send({ id: req.id, result: options.history === undefined ? { data: [] } : options.history });
    }
  });
} else {
  if (options.ignoreTerm) process.on('SIGTERM', () => {});
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { record.stdin += chunk; });
  process.stdin.on('end', () => {
    persist();
    if (options.stderr) process.stderr.write(options.stderr);
    for (const event of options.events || []) send(event);
    if (options.hang) setInterval(() => {}, 1000);
    else process.exitCode = options.exitCode || 0;
  });
}
`;
  await writeFile(scriptPath, script, { mode: 0o755 });
  if (process.platform === 'win32') {
    await writeFile(binary, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    await chmod(scriptPath, 0o755);
  }
  return { binary, recordPath };
}
