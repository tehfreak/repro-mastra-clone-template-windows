# repro-mastra-clone-template-windows

Repro for a Windows-only bug in `create-mastra`. `--template <name>` can't clone anything, because
the clone commands are built with POSIX shell quoting and then run through `cmd.exe`.

## Status

Reported upstream, still open:

- Issue: https://github.com/mastra-ai/mastra/issues/17646
- PR: https://github.com/mastra-ai/mastra/pull/17645 (open, no activity since 2026-06-09)

The PR is the right idea but doesn't land it yet, see below.

## What happens

```
npx create-mastra@latest myapp --template chat-with-pdf
```

```
Failed to clone template: Failed to clone repository: Command failed:
git clone https\://github.com/mastra-ai/template-chat-with-pdf 'C:\Users\me\myapp'
fatal: could not create leading directories of ''C:\Users\me\myapp'': Invalid argument
```

Both clone strategies fail. degit runs first and fails the same way, but its error is swallowed by
a bare `catch {}`, so only the git error reaches the user.

Checked with `create-mastra@1.19.0`.

## Run it

Needs Node >= 22.18, which runs TypeScript without a build step.

```
npm install
npm run repro
```

`repro.ts` runs three implementations against the same inputs: the shipped
`cloneRepositoryWithoutGit()` from `packages/cli/src/utils/clone-template.ts`, the `execFile`
approach from PR #17645, and the suggested `execa` one. It prints two lines, `VERDICT: BROKEN` or
`WORKS` for the shipped code and `PR17645: NPX-ENOENT` or `NPX-OK` for the PR.

The real CLI reproduces it too, but that path prompts for input, so CI runs the script instead.

Types aren't checked at runtime (Node strips them), so `npm run typecheck` does that separately.
`tsconfig.json` sets `erasableSyntaxOnly` so `tsc` rejects anything Node's stripper can't handle.

## Why it's a bug

`cloneRepositoryWithoutGit()` builds a command string and runs it through a shell:

```ts
const degitCommand = shellQuote.quote(['npx', 'degit', degitRepoWithBranch, targetPath]);
await exec(degitCommand, { cwd: process.cwd() });

const gitCommand = shellQuote.quote(gitArgs);
await exec(gitCommand, { cwd: process.cwd() });
```

`shell-quote` emits POSIX quoting. On Windows `child_process.exec` spawns `cmd.exe`, which doesn't
understand either construct it produces here:

```
shell-quote emits        POSIX sh passes on       cmd.exe passes on
https\://github.com/...  https://github.com/...   https\://github.com/... (invalid URL)
'C:\Users\me\myapp'      C:\Users\me\myapp        'C:\Users\me\myapp'     (quotes kept)
```

That's where the doubled quotes in git's error come from.

Linux and macOS are fine, since `exec` uses `/bin/sh` there and the quoting is correct. That's also
why CI never caught it.

## The open PR

PR #17645 drops `shell-quote` and moves to `execFile`. That fixes the `git` call, but `execFile`
runs without a shell, and on Windows `npx` and `npm` are `.cmd` shims, which can't be spawned that
way:

```
execFile('npx', ['--version'])              spawn npx ENOENT
execFile('npm', ['--version'])              spawn npm ENOENT
execFile('git', ['--version'])              ok
execFile('npx', [...], { shell: true })     ok
execa('npx', ['--version'])                 ok
```

So the degit path stays broken on Windows, just with a different error. The PR also converts
`installDependencies` to `execFile(pm, ['install'])`. That one works today, since `npm install` has
nothing `shell-quote` would quote, so converting it this way turns a working call into a broken one.

None of this shows up in Mastra's CI, which runs on ubuntu only. There `npx` and `npm` are ordinary
scripts and `execFile` handles them fine. The absence of a Windows runner is also why the original
bug shipped.

The PR's own tests fail for an unrelated reason: `clone-template.test.ts` still mocks `exec`, so
`util.promisify` gets `undefined` and every case dies with `execFile is not a function`.

## Suggested fix

Pass args as an array instead of building a string, and use a runner that handles `.cmd` shims.
`execa` is already a dependency of `packages/cli`.

```diff
- const degitCommand = shellQuote.quote(['npx', 'degit', degitRepoWithBranch, targetPath]);
- await exec(degitCommand, { cwd: process.cwd() });
+ await execa('npx', ['degit', degitRepoWithBranch, targetPath]);

- const gitCommand = shellQuote.quote(gitArgs);
- await exec(gitCommand, { cwd: process.cwd() });
+ await execa('git', gitArgs);
```

`shell-quote` is used twice more in the same package (`installDependencies` here, `writeAPIKey` in
`packages/cli/src/commands/init/utils.ts`) and can go entirely. The `writeAPIKey` one corrupts API
keys and is tracked separately in
[repro-mastra-writeapikey-windows](https://github.com/tehfreak/repro-mastra-writeapikey-windows).

## CI

`.github/workflows/reproduce.yml` runs the script on `windows-latest` and `ubuntu-latest` and
expects different verdicts on each:

```
windows-latest   VERDICT: BROKEN   PR17645: NPX-ENOENT
ubuntu-latest    VERDICT: WORKS    PR17645: NPX-OK
```

The job is green while both hold, so it goes red if the bug is fixed, if the `execFile` behaviour
changes, or if the platform split stops being a platform split.
