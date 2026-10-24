/* WebAssembly spike: POSIX calls e2fsprogs uses that WASI lacks. None matter for unpacking or packing an image:
 * user/group ids (used only to refuse setuid tricks), popen (mke2fs's optional "fsck at boot" text), alarm, dup,
 * umask, fcntl locks (uuidd's state file). Each fails or returns a harmless value. */
#ifndef WASI_COMPAT_H
#define WASI_COMPAT_H
#ifdef __wasi__
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>

static inline uid_t getuid(void) { return 0; }
static inline uid_t geteuid(void) { return 0; }
static inline gid_t getgid(void) { return 0; }
static inline gid_t getegid(void) { return 0; }
static inline mode_t umask(mode_t m) { (void)m; return 022; }
static inline unsigned alarm(unsigned s) { (void)s; return 0; }
static inline int dup(int fd) { (void)fd; errno = ENOTSUP; return -1; }
static inline FILE *popen(const char *c, const char *m) { (void)c; (void)m; errno = ENOTSUP; return NULL; }
static inline int pclose(FILE *f) { (void)f; errno = ENOTSUP; return -1; }

static inline int mkstemp(char *t) {
    size_t n = strlen(t);
    if (n < 6) { errno = EINVAL; return -1; }
    for (int tries = 0; tries < 100; tries++) {
        for (size_t i = n - 6; i < n; i++) t[i] = "abcdefghijklmnopqrstuvwxyz0123456789"[arc4random_uniform(36)];
        int fd = open(t, O_RDWR | O_CREAT | O_EXCL, 0600);
        if (fd >= 0 || errno != EEXIST) return fd;
    }
    return -1;
}

#ifndef F_RDLCK
#define F_RDLCK 0
#define F_WRLCK 1
#define F_UNLCK 2
#define F_GETLK 5
#define F_SETLK 6
#define F_SETLKW 7

#ifndef ENODATA
#define ENODATA 61 /* Linux value; WASI has none */
#endif
#ifndef ENOATTR
#define ENOATTR ENODATA
#endif
/* erofs calls vf->ops->lseek(...); wasi-libc defines lseek as a function-like macro. */
#ifdef EROFS_MAX_BLOCK_SIZE
#include <unistd.h>
#undef lseek
#endif
#endif
#endif
#endif
