// Public API for the skills module

export { parseFrontmatter } from './frontmatter.js'
export type {
  FrontmatterData,
  FrontmatterValue,
  FrontmatterResult,
  FrontmatterOk,
  FrontmatterErr,
} from './frontmatter.js'

export {
  loadSkillFile,
  loadSkillFolder,
  loadSkillFolderLayout,
  loadSkills,
  loadProjectContext,
} from './loader.js'
export type { SkillLoadResult, SkillFolderLayout } from './loader.js'

// The SkillOpt trainer and its strict held-out validation gate. Off the hot path:
// nothing in `src/loop/` may import this.
export {
  trainSkill,
  splitCases,
  serializeSkill,
  scriptedProposeEdit,
  BEST_SKILL_FILENAME,
  DEFAULT_SPLIT_RATIO,
  DEFAULT_SPLIT_SEED,
  DEFAULT_EPOCHS,
} from './trainer.js'
export type {
  ProposeEdit,
  TrainSkillOptions,
  TrainResult,
  TrainEpoch,
  EpochVerdict,
  CaseSplit,
} from './trainer.js'
