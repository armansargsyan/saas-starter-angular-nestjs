---
name: review-fix
description: Review the current branch's changes (diff against main plus uncommitted work) with the reviewer agent, fix critical and important findings, run nx affected lint/test/build, and re-review once. Use before finishing a task or when asked to /review-fix. Never commits or pushes.
---

# /review-fix

Review the current changes, fix what matters, verify, re-review once, and report. **Do not commit or push**: the user does that.

## 1. Collect the changes

```sh
BASE=$(git merge-base HEAD main)
git diff "$BASE" --stat           # committed on branch + uncommitted (staged and unstaged)
git diff "$BASE"
git ls-files --others --exclude-standard   # untracked files: count them as new files
```

- On `main` itself, `BASE` is `HEAD`, so this covers only uncommitted work, which is intended.
- If there is no diff **and** no untracked files, reply "No changes to review against main." and **stop**.
- Remember `BASE`; later steps use it.

## 2. Review round 1

Launch the **reviewer** agent (`subagent_type: "reviewer"`). It has no shell, so give it everything it needs in the prompt:

- the list of changed and untracked files
- the full diff (if it is very large, over ~1500 lines, give the file list and the hunks' line ranges instead, and tell it to Read those files)
- this instruction:

  > Review only these changes, against CLAUDE.md. Group findings under **Critical**, **Important** and **Nit**. For each finding give `path:line` and a one-sentence reason (plus a short suggested fix for critical/important). Report only issues you can point to in the code. If a group is empty, write "none".

## 3. Fix critical and important findings

Work in the main session (don't delegate fixes). For each critical/important finding:

1. Read the code at `path:line` and confirm the finding is real. If it isn't, mark it **rejected** with a one-line reason.
2. If the finding **conflicts with CLAUDE.md or an intentional design decision** (documented in CLAUDE.md, a code comment, or clearly deliberate), **don't change it**. Mark it **flagged** for the summary.
3. Otherwise apply the **smallest fix limited to that finding**. No refactors, renames, reformatting or "while I'm here" changes. Add or adjust a test only when the fix needs one to be verified.

**Nits are never fixed.** Collect them for the summary.

## 4. Verify

```sh
npx nx affected -t lint test build --base="$BASE"
```

(`nx affected` includes uncommitted and untracked files.) If anything fails, fix the cause with the same small-fix rule, then rerun until it passes. If a failure is unrelated to the changes, or can't be fixed without going beyond scope, stop trying and report it.

## 5. Review round 2 (final)

Recollect the diff (step 1) and run the **reviewer** agent once more with the same instructions, adding: "This is a re-review after fixes. Report only findings that are new or still unresolved."

- If it reports new or unresolved **critical/important** findings, fix them as in step 3, then rerun `npx nx affected -t lint test build --base="$BASE"`.
- **No third review.** Two review rounds in total, at most. Anything still open after round 2 goes in the summary as unresolved.

## 6. Summary

Keep it short:

- **Fixed**: `path:line`: what was wrong, then what changed (one line each).
- **Not fixed (nits)**: `path:line`: reason.
- **Flagged**: findings left unchanged because they conflict with CLAUDE.md or an intentional design, each with why.
- **Rejected / unresolved**: findings that weren't real, or that were still open after round 2, if any.
- **Checks**: lint / test / build: pass or fail, with which project failed and why.
- Reminder: changes are uncommitted; nothing was committed or pushed.
