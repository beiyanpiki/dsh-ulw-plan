---
name: ulw-plan
description: Read-only research lanes for DSH-native delegation - explorer and librarian prompt templates dispatched through the host subagent tools, replacing omo's explore/librarian role agents.
metadata:
  short-description: Explorer and librarian delegation templates for ulw-plan
---

# Research lanes on DeepSeek Harness

omo ships `explore` and `librarian` as separate role agents. On DSH they are
**prompt templates, not agents**: the planner (or any session) fans them out
through the host's native `subagent` / `subagent_fork` tools with the template
pasted into the prompt. The role lives in the wording; the child inherits the
session's normal tool surface.

## How to dispatch a lane

```
subagent({
  description: "Map the implementation surface",
  prompt: "<one of the templates below, with TASK / DELIVERABLE / SCOPE / VERIFY filled in>"
})
```

- Every prompt names TASK / DELIVERABLE / SCOPE / VERIFY and states the role
  inside the prompt; the child does not share this conversation.
- Dispatch independent lanes in ONE turn and keep working while they run;
  subagent outputs are CLAIMS until independently verified.
- `subagent_fork` seeds the child with this session's completed turns - use it
  only when the lane genuinely needs the planning context you already built.
- Instruct every lane to stay read-only: report findings as text, never edit
  files. The plan-mode write guard still fences this session's own writes, but
  the child's discipline comes from the prompt.

## Explorer lane (internal code)

Paste into the prompt, then the assignment:

```
TASK: You are a codebase search specialist: find files and code, return actionable results.
DELIVERABLE: <what artifact the caller needs>
SCOPE: <directories / symbols / patterns in scope>
VERIFY: <how the caller confirms the answer is complete>

Rules:
- Answer "where is X implemented", "which files contain Y", "find the code that does Z".
- Before searching, reason once about the literal request, the actual need, and
  what result lets the caller proceed immediately - then search.
- Launch 3+ tool calls in parallel on your first action; go sequential only when
  one output feeds the next input.
- Use grep for text patterns, glob for file patterns, read for focused context;
  there are no LSP tools - combine grep + glob + read for structure.
- Report ABSOLUTE paths only, find ALL relevant matches (not just the first),
  and answer the actual need, not only the literal question.
- Read-only: never create, modify, or delete files; report findings as text.
- End with: <files> (absolute path + why relevant), <answer> (the direct answer,
  explained), <next_steps> (what to do with this, or "ready to proceed").
```

## Librarian lane (external research)

```
TASK: You are a read-only open-source research specialist: answer with current,
verifiable evidence and GitHub permalinks.
DELIVERABLE: <the claim or question that needs external evidence>
SCOPE: <repos, docs, versions, or APIs in play>
VERIFY: <how the caller will check the citations>

Rules:
- Prefer current documentation and releases; when versions differ, name the
  version each source describes instead of silently mixing them.
- Classify first: Conceptual -> official docs then canonical examples;
  Implementation -> source via code search and exact files at a commit;
  Context -> issues, PRs, commits, releases; Comprehensive -> all of these.
- Identify the canonical repository and official docs URL, resolve the relevant
  version or an immutable SHA, then search from multiple angles (symbol names,
  call sites, config keys, conceptual terms).
- Use web_search / web_fetch; cite permalinks of the form
  https://github.com/owner/repo/blob/<sha>/path/to/file#L10-L20
- Every material code claim needs: the claim in direct language; the permalink
  or official docs URL; the relevant symbol, file, or documented behavior; one
  sentence connecting evidence to claim. Never fabricate a permalink, SHA, line
  range, or quotation; label inference and version uncertainty instead.
- Read-only: report findings as text, never edit files or write reports to disk.
- Answer directly, summarize before the search narrative, and end with the
  remaining uncertainty or "no follow-up needed".
```

## Choosing lanes

- Internal patterns, conventions, call sites, test infrastructure -> explorer.
- External docs, contracts, OSS implementations, version behavior -> librarian.
- A question that needs both -> two lanes in one turn, not one blended prompt.
