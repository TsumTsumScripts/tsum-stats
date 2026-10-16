Read `CODEMAP.md` before searching the tree: it says which file owns what. `node tools/codemap-check.js` checks it against the tree; run it after moving or adding a file.

**Deployments** (local, testers, production): read `../tools/DEPLOYMENTS.md` first.

**Commit as you go, without being asked.** When a block of related changes is
done (a feature, a fix, a docs pass, one asked-for change) and its checks pass
(the tests it touches, `npm run check` for the page, the codemap check), commit
that block on its own with a message saying what changed and why. One commit
per block: not one per file, and not everything in one commit at the end. Stage
only that block's files, never someone else's work in progress, and never build
output (`web/`, `global/site/`). Pushing and deploying still wait to be asked.

**Never permanently drop a data point from an upload.** Every field a round
record carries (base columns and settings alike) is stored in full by the
global site, whether or not any figure uses it yet: no field left out, none
truncated. A figure can ignore a field; the stored round (D1 and its R2
archive) keeps it, so a later figure can use rounds already sent.
