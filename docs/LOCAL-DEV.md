# Running dmux locally (WSL)

How to run dmux, link it to the `~/projects/dmux` checkout, rebuild it, and
verify which dmux code is actually executing.

> These steps are specific to the WSL setup on this machine. Paths use
> `~/projects/dmux` and the package is published as `@blend1983/dmux`.

## 1. How to run dmux

Just type `dmux` from inside any project directory:

```bash
cd ~/some-project
dmux
```

dmux derives its tmux session from the project root, so you normally run it from
the project you want to manage.

For **development** of dmux itself, use the maintainer entrypoint:

```bash
cd ~/projects/dmux
pnpm dev
```

`pnpm dev` bootstraps hooks/docs, compiles TypeScript, and launches dmux from
`dist/index.js` with `DMUX_DEV=true`. Inside tmux it auto-promotes to a watch
loop so edits rebuild and restart automatically.

## 2. Link the local project (so `dmux` runs the checkout)

The global `dmux` command is already `npm link`-ed to the local checkout:

```
~/.nvm/versions/node/v24.18.0/bin/dmux
  -> ../lib/node_modules/@blend1983/dmux/dmux
  -> ../../../../../../../projects/dmux        (symlink)
```

The last hop is the symlink created by `npm link`, so `dmux` executes
`~/projects/dmux/dist/index.js`, **not** a copied/published package.

To re-link (or repair a broken link):

```bash
cd ~/projects/dmux
npm link                 # creates the global symlink to this checkout
```

To switch back to the published npm package:

```bash
npm unlink -g @blend1983/dmux
npm install -g @blend1983/dmux
```

Verify the link is active:

```bash
npm ls -g --depth=0 | grep dmux
# @blend1983/dmux@5.11.1-fork.1 -> ./../../../../../projects/dmux
```

## 3. Rebuild

`dmux` runs the **built `dist/`**, not `src/` directly. After editing TypeScript,
rebuild before running.

Fast recompile (typecheck + emit `dist/`):

```bash
cd ~/projects/dmux
pnpm exec tsc
```

Full build (hooks docs + frontend + TypeScript):

```bash
pnpm run build
```

For continuous rebuild while developing, use `pnpm dev` (or `pnpm dev:watch`).

## 4. Tell which dmux is running

Determine which binary `dmux` resolves to:

```bash
which dmux
# /home/rowand/.nvm/versions/node/v24.18.0/bin/dmux
```

Follow the symlink to its real target (this is the decisive check — it tells you
whether you are running the checkout or a published package):

```bash
readlink -f "$(which dmux)"
# /home/rowand/projects/dmux/dmux   <- local checkout
```

Or see the link target at a glance:

```bash
npm ls -g --depth=0 | grep dmux
```

### Check the build is up to date with source

`dist/` can be stale (built before later `src/` edits). To check:

```bash
cd ~/projects/dmux
find src -name '*.ts' -o -name '*.tsx' | xargs ls -lt | head -3   # newest src
ls -l --time-style=full-iso dist/index.js                          # last build
```

If any `src/` file is newer than `dist/index.js`, the running `dmux` does **not**
include that change. Rebuild with `pnpm exec tsc` and restart dmux.

### Confirm dev mode

When launched with `pnpm dev`, dmux runs with `DMUX_DEV=true`; the footer shows
`DEV MODE` and dev-only actions are visible. A plain `dmux` invocation runs the
same `dist/index.js` but without dev mode.
