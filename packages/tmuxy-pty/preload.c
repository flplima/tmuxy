/*
 * LD_PRELOAD'ed into every program a CheerpX pane runs (see src/main.rs).
 *
 * It records the process's pid, and each fork's, as a file in
 * $TMUXY_PTY_PIDS, so tmuxy-pty can deliver Ctrl+C: CheerpX has no
 * process-group signals and no parent pids in /proc, so this is how the
 * helper finds a pane's processes.
 *
 * It also corrects what waitpid() reports for a process the helper
 * interrupted (marked by a <pid>.int file): CheerpX reports its death by
 * SIGINT as one by SIGKILL, and bash only abandons the rest of a command
 * line for a command that died of SIGINT.
 *
 * And it gives bash's job control what CheerpX lacks for it: no /dev/tty
 * (the CheerpX console), pane pipes that answer as a terminal, and
 * process-group signals (see open(), tcgetpgrp() and killpg()).
 */
#define _GNU_SOURCE
#include <sys/resource.h>
#include <sys/wait.h>

#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

static int
pid_path(char *path, size_t len, pid_t pid, const char *suffix)
{
	const char	*dir = getenv("TMUXY_PTY_PIDS");

	if (dir == NULL)
		return (-1);
	snprintf(path, len, "%s/%d%s", dir, (int)pid, suffix);
	return (0);
}

static void
record(void)
{
	char	path[256];
	int	fd;

	if (pid_path(path, sizeof path, getpid(), "") != 0)
		return;
	fd = open(path, O_CREAT | O_WRONLY | O_CLOEXEC, 0600);
	if (fd != -1)
		close(fd);
}

__attribute__((constructor)) static void
start(void)
{
	record();
	pthread_atfork(NULL, NULL, record);
}

__attribute__((destructor)) static void
stop(void)
{
	char	path[256];

	if (pid_path(path, sizeof path, getpid(), "") == 0)
		unlink(path);
}

/* A SIGKILL death of a process the helper interrupted becomes a SIGINT one. */
static void
translate(pid_t pid, int *status)
{
	char	path[256];

	if (pid <= 0 || status == NULL || !WIFSIGNALED(*status) ||
	    WTERMSIG(*status) != SIGKILL)
		return;
	if (pid_path(path, sizeof path, pid, ".int") == 0 && unlink(path) == 0)
		*status = (*status & ~0x7f) | SIGINT;
}

pid_t
waitpid(pid_t pid, int *status, int options)
{
	static pid_t	(*real)(pid_t, int *, int);
	pid_t		  r;

	if (real == NULL)
		real = (pid_t (*)(pid_t, int *, int))dlsym(RTLD_NEXT, "waitpid");
	r = real(pid, status, options);
	translate(r, status);
	return (r);
}

pid_t
wait4(pid_t pid, int *status, int options, struct rusage *ru)
{
	static pid_t	(*real)(pid_t, int *, int, struct rusage *);
	pid_t		  r;

	if (real == NULL)
		real = (pid_t (*)(pid_t, int *, int, struct rusage *))dlsym(
		    RTLD_NEXT, "wait4");
	r = real(pid, status, options, ru);
	translate(r, status);
	return (r);
}

/*
 * A pane has no controlling terminal, but CheerpX opens /dev/tty anyway, as
 * its one console: the one the control-mode relay reads tmux's commands from.
 * Refused, as Linux refuses a process with no controlling terminal.
 */
int
open(const char *path, int flags, ...)
{
	static int	(*real)(const char *, int, ...);
	mode_t		  mode = 0;
	va_list		  ap;

	if (real == NULL)
		real = (int (*)(const char *, int, ...))dlsym(RTLD_NEXT, "open");
	if (flags & (O_CREAT | O_TMPFILE)) {
		va_start(ap, flags);
		mode = va_arg(ap, mode_t);
		va_end(ap);
	}
	if (path != NULL && strcmp(path, "/dev/tty") == 0) {
		errno = ENXIO;
		return (-1);
	}
	return (real(path, flags, mode));
}

/*
 * A pane's pipes are no terminal, so bash -i finds no foreground process
 * group there and warns "no job control in background" in every pane. Asked
 * about one, a pipe answers as a terminal the caller's group owns.
 */
static int
pane_pipe(int fd)
{
	return (fcntl(fd, F_GETFD) != -1 && !isatty(fd));
}

pid_t
tcgetpgrp(int fd)
{
	static pid_t	(*real)(int);
	pid_t		  r;

	if (real == NULL)
		real = (pid_t (*)(int))dlsym(RTLD_NEXT, "tcgetpgrp");
	r = real(fd);
	if (r == -1 && pane_pipe(fd))
		return (getpgrp());
	return (r);
}

int
tcsetpgrp(int fd, pid_t pgrp)
{
	static int	(*real)(int, pid_t);
	int		  r;

	if (real == NULL)
		real = (int (*)(int, pid_t))dlsym(RTLD_NEXT, "tcsetpgrp");
	r = real(fd, pgrp);
	if (r == -1 && pane_pipe(fd))
		return (0);
	return (r);
}

int
tcsetattr(int fd, int actions, const struct termios *t)
{
	static int	(*real)(int, int, const struct termios *);
	int		  r;

	if (real == NULL)
		real = (int (*)(int, int, const struct termios *))dlsym(
		    RTLD_NEXT, "tcsetattr");
	r = real(fd, actions, t);
	if (r == -1 && pane_pipe(fd))
		return (0);
	return (r);
}

/*
 * CheerpX cannot signal a process group, and bash's job control (`kill %1`,
 * `fg`) signals one: send it to each of the pane's recorded processes in it.
 */
int
killpg(pid_t pgrp, int sig)
{
	static int	(*real)(pid_t, int);
	const char	*dir = getenv("TMUXY_PTY_PIDS");
	DIR		*d;
	struct dirent	*e;
	char		*end;
	long		 pid;
	int		 r, found = 0;

	if (real == NULL)
		real = (int (*)(pid_t, int))dlsym(RTLD_NEXT, "killpg");
	r = real(pgrp, sig);
	if (r == 0 || errno != ESRCH || dir == NULL || (d = opendir(dir)) == NULL)
		return (r);
	while ((e = readdir(d)) != NULL) {
		pid = strtol(e->d_name, &end, 10);
		/* getpgid() of a pid that is gone hangs CheerpX: check first. */
		if (pid <= 0 || *end != '\0' || kill((pid_t)pid, 0) != 0 ||
		    getpgid((pid_t)pid) != pgrp)
			continue;
		if (kill((pid_t)pid, sig) == 0)
			found++;
	}
	closedir(d);
	if (found == 0) {
		errno = ESRCH;
		return (-1);
	}
	return (0);
}
