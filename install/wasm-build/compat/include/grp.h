/* WASI spike: no groups. */
#ifndef GRP_H
#define GRP_H
#include <sys/types.h>
struct group { char *gr_name; char *gr_passwd; gid_t gr_gid; char **gr_mem; };
static inline struct group *getgrnam(const char *n) { (void)n; return 0; }
static inline struct group *getgrgid(gid_t g) { (void)g; return 0; }
#endif
