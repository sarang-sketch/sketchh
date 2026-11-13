// EGM (Elephant-Goldfish Model) commands: the seven skills as slash commands
// and as the EGM panel's list. One definition each — `slashCommands.ts`
// spreads these into the composer's `/` menu and `EgmPanel` renders them — so
// a command's name, description, and skill can never disagree between the
// two surfaces.
//
// Each command loads its skill in full (`skillNames`) when the skill is
// installed in the project, AND carries a self-contained expanded prompt:
// a missing skill is a diagnostic, not a failed run, so the command still
// works from the prompt alone, with the file conventions and the Goldfish
// fresh-context rule spelled out. The skill text is the authority; the prompt
// is the fallback, not a second copy of the workflow.

import type { AgentMode } from '../state/AppState'

/** The seven EGM skills, in workflow order. */
export const EGM_SKILL_NAMES = [
  'egm-brainstorm',
  'egm-draft',
  'egm-review',
  'egm-resolve',
  'egm-bootstrap',
  'egm-drift-report',
  'egm-review-loop',
] as const

export type EgmSkillName = (typeof EGM_SKILL_NAMES)[number]

export interface EgmCommandDef {
  /** What the user types after `/`, and the skill it loads. */
  name: EgmSkillName
  /** Short label for the panel. */
  title: string
  /** One line for the `/` menu and the panel. */
  description: string
  argumentHint?: string
  /** Read-only commands run in Ask mode; the rest use the composer's mode. */
  mode?: AgentMode
  /** The prompt sent when the command runs (see the header comment). */
  expand: (args: string, context: { file: string | null }) => string
  /** True for the Goldfish review commands: they must run in a fresh session. */
  freshSession?: boolean
}

const target = (args: string, file: string | null, fallback: string): string =>
  args.trim() !== '' ? args.trim() : file !== null ? `\`${file}\`` : fallback

export const EGM_COMMANDS: readonly EgmCommandDef[] = [
  {
    name: 'egm-brainstorm',
    title: 'Brainstorm',
    description: 'Test an idea with clarifying questions and a fresh-eyes review; saves concepts_brief.md',
    argumentHint: '<idea>',
    expand: (args) =>
      'Use the egm-brainstorm skill to explore this idea: ' +
      `${args.trim() || 'ask me what I want to brainstorm'}. ` +
      'Ask open-ended clarifying questions first, across several turns, until the problem, constraints, and success measure are clear. ' +
      'Only after I confirm the anchored hypothesis, run the Goldfish lenses in a fresh session and save the agreed direction to concepts_brief.md. ' +
      'Never present the brief in the chat — write the file and give me its path.',
  },
  {
    name: 'egm-draft',
    title: 'Draft',
    description: 'Turn a brief or notes into a design document, section by section, saving the approved spec under docs/designs/',
    argumentHint: '[brief or notes]',
    expand: (args) =>
      'Use the egm-draft skill to draft a design document' +
      `${args.trim() !== '' ? ` from ${args.trim()}` : ' from concepts_brief.md if it exists, otherwise ask me for the problem, goals, and context'}. ` +
      'Write it section by section to design_draft.md, pausing for my approval after each section. ' +
      'When every section is approved, reconcile it against the brief, save it under docs/designs/, register it in SITEMAP.md if one exists, and recommend /egm-review on it.',
  },
  {
    name: 'egm-review',
    title: 'Review',
    description: 'Review a design with fresh-eyes Goldfish reviewers across five stages — runs in a fresh session, no prior chat history',
    argumentHint: '<design document>',
    mode: 'ask',
    freshSession: true,
    expand: (args, { file }) =>
      'Use the egm-review skill to review ' +
      `${target(args, file, 'the design document I name next — ask me for its path first if I did not give one')}. ` +
      'This MUST run as a fresh Goldfish review: read only the document and the files it links to, with no prior chat history. ' +
      'If this conversation drafted the document, stop and tell me to start a new conversation first — a review in the drafting conversation is not a Goldfish review. ' +
      'Run the five stages (Zoom Out, Comprehension, Critic, Intermediate Zoom Out, Implementation Readiness), write each stage report to a file, and finish with a consolidated report. ' +
      'A reviewer that fails is recorded as not run, never as zero findings.',
  },
  {
    name: 'egm-resolve',
    title: 'Resolve',
    description: 'Work through Goldfish review findings — contest, escalate, propose fixes, or decline — writing goldfish_review_report.md',
    argumentHint: '[report or document]',
    expand: (args, { file }) =>
      'Use the egm-resolve skill to work through the Goldfish review findings' +
      `${args.trim() !== '' ? ` for ${args.trim()}` : file !== null ? ` for \`${file}\`` : ''}. ` +
      'Run this in this (drafting) conversation — resolution needs the history the reviewers must not have. ' +
      'Categorize each finding CONTEST, ESCALATE, PROPOSE FIX, or DECLINE, write goldfish_review_report.md, and ask me how to proceed before applying any fix.',
  },
  {
    name: 'egm-bootstrap',
    title: 'Bootstrap',
    description: 'Document an existing codebase bottom-up — a README per directory, rolled up — without changing any code',
    argumentHint: '[directory]',
    expand: (args) =>
      'Use the egm-bootstrap skill to document the codebase under ' +
      `${args.trim() || 'the project root'}. ` +
      'Documentation only: do not write or refactor any functional source code, and do not commit anything. ' +
      'If the tree has more than 15 subdirectories, ask me for approval before full-tree execution.',
  },
  {
    name: 'egm-drift-report',
    title: 'Drift report',
    description: 'Compare design documents with the current code and report where they diverge',
    argumentHint: '[designs directory]',
    mode: 'ask',
    expand: (args) =>
      'Use the egm-drift-report skill on ' +
      `${args.trim() || 'docs/designs/'}. ` +
      'For each design document, compare what it specifies with the current source code and report ONLY the differences, in {YYYY-MM-DD}_DRIFT_REPORT.md. ' +
      'Never fix drift yourself — the report is the input to my decision.',
  },
  {
    name: 'egm-review-loop',
    title: 'Review loop',
    description: 'Run a configured group of Goldfish reviewers against a document until the review converges (max 5 rounds)',
    argumentHint: '<document>',
    mode: 'ask',
    freshSession: true,
    expand: (args, { file }) =>
      'Use the egm-review-loop skill on ' +
      `${target(args, file, 'the document I name next — ask me for its path first if I did not give one')}. ` +
      'This MUST run in a fresh session: reviewers read only the document, their standard, and the Goldfish context — no prior chat history. ' +
      'Run the sharpening loop (review, resolve with me, repeat) until two consecutive clean rounds, the 5-round cap, or churn, and report the outcome.',
  },
]

/** The command definition for a skill name, or undefined for a non-EGM skill. */
export function egmCommand(name: string): EgmCommandDef | undefined {
  return EGM_COMMANDS.find((command) => command.name === name)
}
