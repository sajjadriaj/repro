/** Library surface, for embedding repro in a harness or CI job. */
export * from './spec.js'
export * from './run.js'
export * from './minimize.js'
export * from './explain.js'
export * from './compile.js'
export * from './bisect.js'
export * from './seal.js'
export * from './agent.js'
export * from './hook.js'
export * from './worktree.js'
export * from './integrations/claude-code.js'
export { VERSION } from './version.js'
export {
  newRunDir,
  treeSnapshot,
  diffSnapshots,
  changedFiles,
  type FileChanges,
  type NetworkEntry,
  type RunDir,
} from './evidence.js'
export { renderRun, renderCoverage, renderMinimize, renderExplain, renderEstablish, renderSeal, renderVerify, renderStatus } from './report.js'
