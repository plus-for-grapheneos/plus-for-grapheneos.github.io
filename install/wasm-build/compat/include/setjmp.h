/* WASI spike: setjmp/longjmp would need WebAssembly exception handling; e2fsprogs uses them only for mke2fs's
 * interactive timeout, which afsr never reaches. */
#ifndef SETJMP_H
#define SETJMP_H
#include <stdlib.h>
typedef int jmp_buf[1];
#define setjmp(b) 0
#define longjmp(b, v) abort()
#endif
