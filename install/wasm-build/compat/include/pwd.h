/* WASI spike: no user database. */
#ifndef PWD_H
#define PWD_H
#include <sys/types.h>
struct passwd { char *pw_name; char *pw_passwd; uid_t pw_uid; gid_t pw_gid; char *pw_gecos; char *pw_dir; char *pw_shell; };
static inline struct passwd *getpwnam(const char *n) { (void)n; return 0; }
static inline struct passwd *getpwuid(uid_t u) { (void)u; return 0; }
#endif
