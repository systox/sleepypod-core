# Fork guidance

This is a personal fork of sleepypod/core. `AGENTS.md` is upstream's guidance
and still applies; these rules cover what the fork adds. Their purpose is to
keep upstream's improvements easy to merge.

## Branches and remotes

- `origin` is the fork. `upstream` is sleepypod/core and is fetch-only.
- All work goes on `pod5`. Never push `main` or `dev` to the fork: upstream's
  release workflows fire on those branches.
- Bring upstream in by merging `upstream/main` into `pod5`, one release at a
  time. Never rebase or force-push `pod5`.
- Never open a pull request, or reference an upstream issue or person in a
  commit, without the owner's approval.

## Keeping the diff small

- Put new code in new files, with a line or two in upstream files to call it.
- Do not reformat, rename, move or tidy upstream code.
- Avoid database migrations: upstream's are numbered in sequence, so ours would
  collide, and a migrated database makes a return to stock harder. Keep fork
  settings in the fork's own file.
- Avoid new dependencies and regenerated locale files.
- When a clean design and a small diff conflict, prefer the small diff and say
  what it costs.
- Check drift with `git diff --stat upstream/main...pod5`.

## Commits and behaviour

- Keep bug fixes in separate commits from features, so a fix can be offered
  upstream and dropped here once accepted.
- New behaviour starts off by default, behind a setting, so it can be turned
  off without a reinstall.
- This repo is public. Keep names, personal curves, addresses, keys and sleep
  data out of it. Per-Pod values belong on the Pod.
- Commit with the GitHub no-reply address.

## Installing on the Pod

Install with the bed empty:

```bash
SLEEPYPOD_GITHUB_REPO=systox/sleepypod-core sp-update pod5
```

`sp-update` deletes and rebuilds each Python module's virtual environment and
its package cache is empty, so copy `piezo-processor/.venv` aside first. A failed
rebuild only warns, leaving that module dead. Afterwards verify the schedules,
firewall, time sync, calibration settings, the stock `dac` mask and all five
modules.
