/* WASI spike: Linux device-number macros. */
#ifndef SYS_SYSMACROS_H
#define SYS_SYSMACROS_H
#define major(d) ((unsigned)(((d) >> 8) & 0xfff) | (unsigned)(((d) >> 32) & ~0xfffu))
#define minor(d) ((unsigned)((d) & 0xff) | (unsigned)(((d) >> 12) & ~0xffu))
#define makedev(x, y) ((dev_t)((((unsigned long long)(x) & 0xfffu) << 8) | (((unsigned long long)(x) & ~0xfffull) << 32) | ((y) & 0xffu) | (((unsigned long long)(y) & ~0xffull) << 12)))
#endif
