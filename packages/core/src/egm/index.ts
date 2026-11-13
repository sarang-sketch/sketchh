// EGM (Elephant-Goldfish Model) support in the engine: the Goldfish context
// builder, the five-stage review protocol, and the Elephant artifact
// conventions. The skills themselves are prompts — see
// `packages/core/registry/skills/egm-*/SKILL.md` — and this module is the
// deterministic half: what a reviewer may read, how a review is staged and
// judged, and where the artifacts live.

export {
  buildGoldfishContext,
  extractMarkdownLinks,
  type BuildGoldfishContextOptions,
  type BuildGoldfishContextResult,
  type ExcludedLink,
  type GoldfishContext,
  type GoldfishFile,
} from './freshContext.js'
export {
  CONSOLIDATED_REPORT_FILE,
  REVIEW_LOOP_MAX_ROUNDS,
  REVIEW_STAGES,
  RESOLVE_REPORT_FILE,
  SEVERITY_ORDER,
  assessRound,
  dedupeFindings,
  discoverSemanticSplit,
  hasConverged,
  renderConsolidatedReport,
  renderResolveReport,
  sortFindings,
  type CategorizedFinding,
  type Finding,
  type FindingSeverity,
  type ResolveCategory,
  type ReviewStage,
  type RoundAssessment,
  type SemanticSplit,
} from './review.js'
export {
  CONCEPTS_BRIEF_FILENAME,
  DESIGN_DRAFT_FILENAME,
  DESIGNS_DIR,
  SITEMAP_FILENAME,
  conceptsBriefTemplate,
  designDocPath,
  designDraftTemplate,
  driftReportFilename,
  sitemapEntry,
} from './artifacts.js'
