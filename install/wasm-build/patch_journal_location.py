"""afsr on WASI: mke2fs runs twice in one process (two pack passes). mke2fs PRS() frees the global
journal_location_string (misc/util.c) but leaves the pointer dangling; the second run sees it non-NULL,
reads the freed string and frees it again (double free), corrupting the heap -- the later trap in
ext2fs_hashmap_lookup during the second populate pass. A separate mke2fs process never notices.
Usage: python3 patch_journal_location.py [afsr source root]"""
import sys
root = sys.argv[1]  # the afsr source tree
p = root + "/external/e2fsprogs/misc/mke2fs.c"
s = open(p).read()
old = "\tfree(journal_location_string);\n"
new = "\tfree(journal_location_string);\n\tjournal_location_string = NULL;\n"
if new not in s:
    assert s.count(old) == 1, s.count(old)
    open(p, "w").write(s.replace(old, new))
print("ok")
