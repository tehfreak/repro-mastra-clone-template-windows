import child_process from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import shellQuote from 'shell-quote';
import { execa } from 'execa';

const exec = util.promisify(child_process.exec);
const execFile = util.promisify(child_process.execFile);

const REPO_URL = 'https://github.com/mastra-ai/template-chat-with-pdf';
const SANDBOX = path.join(os.tmpdir(), 'repro-mastra-clone-template');

async function fresh(sub: string): Promise<string> {
  const p = path.join(SANDBOX, sub);
  await fs.rm(p, { recursive: true, force: true });
  await fs.mkdir(p, { recursive: true });
  return p;
}

function section(title: string): void {
  console.log('\n' + title);
  console.log('-'.repeat(title.length));
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0];
}

function indent(error: unknown, lines = 3): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .split('\n')
    .slice(0, lines)
    .map(line => '    ' + line)
    .join('\n');
}

async function currentImplementation(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true });

  const degitRepo = REPO_URL.replace('https://github.com/', '');
  const degitCommand = shellQuote.quote(['npx', 'degit', degitRepo, targetPath]);
  console.log('  degit command:');
  console.log('    ' + degitCommand);
  try {
    await exec(degitCommand, { cwd: process.cwd() });
    console.log('  degit: ok');
    return;
  } catch (error: unknown) {
    console.log('  degit: failed (the real code swallows this in a bare catch)');
    console.log(indent(error, 6));
  }

  const gitCommand = shellQuote.quote(['git', 'clone', REPO_URL, targetPath]);
  console.log('\n  git fallback command:');
  console.log('    ' + gitCommand);
  try {
    await exec(gitCommand, { cwd: process.cwd() });
    console.log('  git clone: ok');
  } catch (error: unknown) {
    console.log('  git clone: failed');
    console.log(indent(error, 3));
    throw error;
  }
}

async function prImplementation(targetPath: string): Promise<boolean> {
  await fs.mkdir(targetPath, { recursive: true });
  const degitRepo = REPO_URL.replace('https://github.com/', '');

  let npxSpawnFailed = false;

  console.log("  execFile('npx', ['degit', ...])");
  try {
    await execFile('npx', ['degit', degitRepo, targetPath]);
    console.log('    ok');
  } catch (error: unknown) {
    const line = firstLine(error);
    npxSpawnFailed = line.includes('ENOENT');
    console.log('    failed: ' + line);
  }

  console.log("  execFile('git', ['clone', ...])");
  try {
    await execFile('git', ['clone', REPO_URL, targetPath]);
    await fs.rm(path.join(targetPath, '.git'), { recursive: true, force: true });
    console.log('    ok');
  } catch (error: unknown) {
    console.log('    failed: ' + firstLine(error));
  }

  console.log("  installDependencies becomes execFile(pm, ['install'])");
  try {
    await execFile('npm', ['--version']);
    console.log("    execFile('npm', ['--version']): ok");
  } catch (error: unknown) {
    console.log("    execFile('npm', ['--version']): failed: " + firstLine(error));
  }

  return npxSpawnFailed;
}

async function suggestedFix(targetPath: string): Promise<string> {
  await fs.mkdir(targetPath, { recursive: true });

  const degitRepo = REPO_URL.replace('https://github.com/', '');
  try {
    await execa('npx', ['degit', degitRepo, targetPath]);
    return 'degit';
  } catch (error: unknown) {
    console.log('  degit failed, falling back to git');
    console.log(indent(error, 2));
  }

  await execa('git', ['clone', REPO_URL, targetPath]);
  await fs.rm(path.join(targetPath, '.git'), { recursive: true, force: true });
  return 'git clone';
}

section('environment');
console.log('  platform:', process.platform);
console.log('  node:', process.version);
console.log('  ComSpec:', process.env.ComSpec ?? '(not windows)');

let broken = false;

section('current implementation (shell-quote + child_process.exec)');
{
  const target = path.join(await fresh('current'), 'myapp');
  try {
    await currentImplementation(target);
    console.log('\n  clone succeeded');
  } catch {
    broken = true;
    console.log('\n  clone failed');
  }
}

section('pr #17645 (execFile, no shell)');
const npxEnoent = await prImplementation(path.join(await fresh('pr17645'), 'myapp'));

section('suggested fix (execa with an args array)');
{
  const target = path.join(await fresh('fixed'), 'myapp');
  try {
    const via = await suggestedFix(target);
    const files = await fs.readdir(target);
    console.log('  cloned via:', via);
    console.log('  files:', files.length, '->', files.slice(0, 8).join(', '));
    console.log('  has package.json:', files.includes('package.json'));
  } catch (error: unknown) {
    console.log('  the fix failed too, which it should not:');
    console.log(indent(error, 3));
  }
}

section('verdict');
console.log(broken ? 'VERDICT: BROKEN' : 'VERDICT: WORKS');
console.log(npxEnoent ? 'PR17645: NPX-ENOENT' : 'PR17645: NPX-OK');
console.log('sandbox:', SANDBOX);
