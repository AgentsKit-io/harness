export { LOOP_CONFIG_FILE, LOOP_CONFIG_SCHEMA_VERSION, LOOP_LOCAL_CONFIG_FILE, LoopConfigSchema, loadLoopConfig, mergeLoopConfig, parseLoopConfigText, parseModelRef, providerIdentity, renderTuiCommand, tiersFor, validateLoopConfig } from './config.js'
export type { LoadedLoopConfig, LoopConfig, LoopConfigInput, LoopProviderConfig, ModelReference, EffortLevel } from './config.js'
export { AGENT_REGISTRY_SCHEMA_VERSION, AgentRegistryEntrySchema, AgentRegistrySchema, loadAgentRegistry, parseAgentRegistryText, resolveAgentForRole } from './agent-registry.js'
export type { AgentRegistry, AgentRegistryEntry, ResolvedAgent } from './agent-registry.js'
export { createProcessRunner } from './process.js'
export { assessSlots, availableMemoryBytes, isWsl, parseMemInfo, parseVmStat } from './slots.js'
export type { SlotAssessment, SlotInput } from './slots.js'
export { rankModels, routeAllRoles, selectModel } from './routing.js'
export type { RankedModel, RoutingDecision, RoutingSkip } from './routing.js'
export {
  fetchArtificialAnalysisModels, listCliModels, loadAliases, loadBuiltinCatalog, parseArtificialAnalysisPayload,
  parseGrokModelsOutput, readAaCache, resolveAlias, resolveCatalogCandidates, writeAaCache,
} from './model-catalog/index.js'
export type { ArtificialAnalysisModel, CatalogModel, ModelQuality, ProviderCatalog } from './model-catalog/index.js'
export { activeCooldowns, clearProviderCooldown, cooldownPath, markProviderExhausted, readCooldowns } from './cooldown.js'
export type { CooldownEntry, CooldownState } from './cooldown.js'
export { countRunningWorkers, providerSpecs, runLoopDoctor } from './doctor.js'
export type { DoctorCheck, DoctorCheckStatus, LoopDoctorInput, LoopDoctorReport } from './doctor.js'
export { CONTRACT_CLOSE, CONTRACT_OPEN, CONTRACT_SCHEMA_VERSION, ContractOutcomeSchema, TaskContractSchema, assessContract, contractIsFresh, contractPath, generateContract, parseContractOutput, readStoredContract, renderContractPrompt, resolveDocContext, untrusted, writeStoredContract } from './contract.js'
export { classifyProviderFailure, extractResetsAt } from './contract.js'
export type { ContractAssessment, GenerateContractInput, ProviderFailure, StoredContract, TaskContract } from './contract.js'
export { renderHandoffBrief, renderWorkerBrief } from './brief.js'
export type { HandoffBriefInput, WorkerBriefInput } from './brief.js'
export { appendLoopEvent, branchFor, briefPath, busyIssues, dispatchRecordPath, gatherLoopState, launchWorkerTerminal, precheckTick, readDispatchRecord, writeDispatchRecord, runTick, worktreeNameFor } from './tick.js'
export type { DispatchRecordFile, LoopState, TickCandidateResult, TickInput, TickOutcome, TickReport } from './tick.js'
export { deliveryStatePath, listDispatched, precheckDeliver, readDeliveryState, runDeliver } from './deliver.js'
export type { DeliverInput, DeliverOutcome, DeliverReport, DeliverResult, DeliveryState } from './deliver.js'
export { LOOP_STAGES, automationName, automationPrompt, automationSpecs, installLoopAutomations, loopStatus, parseAutomationRuns, precheckCommand, shellQuote, uninstallLoopAutomations } from './install.js'
export type { AutomationStatus, InstallAction, InstallInput, InstallReport, LoopStage, LoopStatusReport } from './install.js'
export { advanceQueueOwner, queueOwner, rotationStatePath } from './rotation.js'
export { installPreflight, runGuidedInstall } from './guided-install.js'
export { createRichIO } from './ui/terminal.js'
export type { RichIO } from './ui/terminal.js'
export { fetchTeamMembers, hasLocalConfig, localConfigPath, parseTeamMembers, promptLocalConfig, renderLocalConfig, writeLocalConfig } from './local-config.js'
export type { LocalConfigAnswers, LocalConfigPrompter, TeamMember } from './local-config.js'
export type { GuidedInstallIO, GuidedInstallInput, GuidedInstallReport } from './guided-install.js'
export { HARNESS_REPO_URL, buildRetroReport, buildSuggestions, normalizeReason, parseSince, readLoopEvents, renderRetroMarkdown, retroLearnings, runRetroStage } from './retro.js'
export type { LoopEvent, RetroInput, RetroIssueRow, RetroReport, RetroStageReport, RetroSuggestion, RetroTarget, RetroWindow } from './retro.js'
export {
  createFileMemoryAdapter, createFileMemoryKvStore, learningToMemoryRecord, memoryDigestOf, openLoopMemory,
  planMemoryContext, preferMemoryOverDocBridge, promoteLearningsToMemory, readLearningsLedger, selectMemoryForPrompt,
  upsertProposedLearnings, writeLearningsLedger, learningsPath,
} from './memory.js'
export type { LearningsLedger, MemoryContextPlan, MemoryPromptSelection } from './memory.js'

export { buildDebriefReport, renderDebriefMarkdown } from './debrief.js'
export type { DebriefInput, DebriefIssueRow, DebriefReport } from './debrief.js'
export { classifyWatchEvent, classifyWatchPhase, formatWatchEvent, snapshotWatchTargets, watchDeliveries } from './watch.js'
export type { WatchEvent, WatchEventKind, WatchInput, WatchReport, WatchTargetSnapshot } from './watch.js'

export {
  clearIssueFailures, isIssuePaused, isStagePaused, issueFailurePath, listPausedIssues, pauseIssue, readIssueFailures,
  readStagePause, recordIssueFailure, recordStageRunResult, resumeIssue, resumeStage, stageEntry, stagePausePath,
} from './resilience-state.js'
export type { IssueFailureRecord, IssueFailureState, LoopStageName, StagePauseEntry, StagePauseState } from './resilience-state.js'

export { loadPinnedSkills, renderPinnedSkills, skillDigest, skillRefs } from './skills.js'
export type { PinnedSkill, PinnedSkillRef } from './skills.js'

export { discoverIntake, intakeIssueId, intakePath, listIntake, readIntake } from './github-intake.js'
export type { IntakeRecord } from './github-intake.js'

export { createLoopEventBus, loadLoopPlugins } from './event-bus.js'
export type { LoopEventBus, LoopEventListener, LoopEventPayload, LoopHookListener, LoopHookName, LoopHookPayload, LoopHookResult, LoopPluginModule } from './event-bus.js'
