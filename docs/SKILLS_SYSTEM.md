# Skills

A skill is a folder of instructions the agent can load: a `SKILL.md` with frontmatter, or a community-format folder with `skill.json`. Skills work with any model, local or hosted, and need no online marketplace.

## Formats

- **`SKILL.md`**: YAML-subset frontmatter (`name`, `description`, `capabilities`, and more) and a Markdown body (`packages/core/src/skills/frontmatter.ts`).
- **`skill.json` folder**: `skill.json` for name, description and capabilities; `README.md` and `prompts/` become the body; `workflows/`, `tools/`, `tests/` and `examples/` are listed and read by path when used (`skills/loader.ts`).

Both normalise to the same shape, so nothing downstream can tell them apart.

## Where skills live

| Location | Status |
|---|---|
| `<project>/.sketch/skills/<name>/` | Loaded for runs in that project |
| `~/.sketch/registry/` | The built-in registry Sketch unpacks; installing copies a skill into the project |
| `~/.sketch/skills/` (global) | **Not supported yet** (roadmap M7) |

## Using a skill

- **Manually:** type `/` in the composer and pick a skill; the run gets it by name.
- **Automatically:** the `use_skill` tool lists installed skills to the model, which loads one when it fits the task.
- **Custom commands:** Markdown files in `.sketch/commands/` or `~/.sketch/commands/` appear in the same `/` menu.

## Permissions

A skill declares the capabilities it needs (for example `fs:write:project`, `proc:spawn`, `net:http`). For a skill installed from the registry, the user approves those capabilities once and the approval is stored as a grant bound to the skill's content digest (`registry/grants.ts`, `.sketch/skills/.grants/`). If the skill's files change, the digest no longer matches and the grant denies everything. The agent cannot write grants (`tools/protectedPaths.ts`).

## Installing and validating

`skill-install` verifies a skill's digest before writing anything and has no "force" switch. `parse-skill` validates a skill without installing it. Community skills install through the same path.

## Training a skill (SkillOpt method)

Skills → Installed → Training method: **Small edits (SkillOpt)** proposes up to 4 edits per round, each tied to exact text in the skill, and keeps a list of edits that did not help; **Full rewrite** proposes a new body. Either way the skill changes only if held-out evaluation runs score higher (`skills/trainer.ts`, `skills/editOptimizer.ts`).

## Not implemented

- Creating, editing and deleting skills from a form (files can be edited in the editor).
- Global skills, skill dependencies, update checks.
- The 12 default role skills the brief lists (Frontend Developer, Backend Developer, Database Architect, Code Reviewer, Debugging Expert, Security Reviewer, Documentation Writer, Testing Engineer, API Developer, UI/UX Reviewer, Refactoring Expert, Project Architect). The registry currently seeds 7 other skills.

Tests: `skills`, `frontmatter`, `registry`, `registry.embedded`, `skill-edits`, `edit-optimizer`, `skill-train-edits`, `SkillsMarketplace`.
