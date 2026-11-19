Any pull request or draft PR is welcome, at any stage. You do not need to claim an issue first.

## Where to start

Read [CONTRIBUTING.md](https://github.com/flplima/tmuxy/blob/main/CONTRIBUTING.md). It covers setup, the two review speeds and a few good first changes: a theme, a CLI command, a menu item.

Using an AI agent is welcome. The repo ships an `AGENTS.md` so your agent has the context.

## Set it up without touching your tmux

The sandbox runs an agent in its own container, with its own tmux socket:

```sh
git clone https://github.com/flplima/tmuxy.git
cd tmuxy
bin/sandbox build && bin/sandbox up my-task
bin/sandbox claude my-task
```

I recommend it, unless you don't mind your agent messing with your host tmux sessions. VS Code Dev Containers and GitHub Codespaces use the same `.devcontainer/`.

## Find your way around the code

The [docs index](https://github.com/flplima/tmuxy/blob/main/docs/README.md) lists every engineering doc. Two good first stops:

- [Architecture index](https://github.com/flplima/tmuxy/blob/main/docs/ARCHITECTURE-INDEX.md): where each concern lives in the tree
- [Non-goals](https://github.com/flplima/tmuxy/blob/main/docs/NON-GOALS.md): what tmuxy leaves out on purpose. Check it before a big change

## Report a bug

Open an [issue](https://github.com/flplima/tmuxy/issues). A good report says what you did, what you expected and what happened, plus `tmuxy --version` and `tmux -V`. [[Troubleshooting]] shows how to attach a trace.

## Report a security problem

Do not use a public issue. Use a [GitHub security advisory](https://github.com/flplima/tmuxy/security/advisories/new), which reaches the maintainer alone.

## Edit this wiki

The wiki's source is the `docs/wiki/` folder of the repository. Send a pull request that changes those files. Please do not use the wiki's edit button.

## See also

- [[Home]]
- [[Troubleshooting]]
- [[Security]]
