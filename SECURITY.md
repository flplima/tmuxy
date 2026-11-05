# Security Policy

## Reporting a vulnerability

Report it privately through a [GitHub security advisory](https://github.com/flplima/tmuxy/security/advisories/new). The report reaches the maintainer alone, and the advisory is where the fix is discussed, credited and, once released, published.

Please do not open a public issue, discussion or pull request for a vulnerability before it is fixed.

A useful report says:

- what an attacker can do, and from where: the network, a web page in the same browser, a program running in a pane, a plugin;
- the tmuxy version (`tmuxy --version`), how it runs (desktop app, `tmuxy-server` on loopback or on a network, the demo) and the OS;
- the steps that reproduce it. A trace slice helps (`tmuxy trace --last 5`), taken at the default `shape` level, which holds no terminal content.

## What counts

tmuxy gives whoever reaches it a shell, so access to a shell is not a vulnerability in itself. These are:

- reaching a session without the credentials the deployment asks for, or past the host and origin checks;
- a page, a link, terminal output, a previewed file (`tmuxy open`) or a plugin doing something the user did not ask for: running a command, typing into a pane, reading another pane, reaching the network;
- a secret leaving the machine: a password, a session token, a push key, a trace or snapshot written where others can read it.

The risks the design already accepts, such as running with `--no-auth` on a routable address, are described in the threat model, [docs/SECURITY.md](docs/SECURITY.md). A way past one of its mitigations is a vulnerability.

## Supported versions

Fixes land on `main` and ship in the next release. Only the latest release is supported; there are no backports to older ones.
