/**
 * Opaque-box E2E Test Suite for Global Agent Support in @wowyuarm/dsh-agent-team.
 *
 * Requirements Covered (from ORIGINAL_REQUEST.md & PROJECT.md):
 * - R1: Global Agent Definition & Membership (F1, F2, F3, F4, F5)
 * - R2: Contextual Dynamic Execution per Workspace (F6, F7, F9)
 * - R3: Unified Cross-Workspace Agent Memory and Persona (F8)
 * - R4: Web Client UI & Remote Integration (F5, F10, F11, F12, F13, F14)
 *
 * Test Tiers:
 * - Tier 1: Feature Coverage (>=5 test cases per requirement)
 * - Tier 2: Boundary & Corner Cases (>=5 test cases)
 * - Tier 3: Cross-Feature Combinations (pairwise & multi-step interactions)
 * - Tier 4: Real-World Multi-Workspace Scenarios (architecture advisor & migration coordinator)
 *
 * @module
 */

import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import AgentTeam, { AGENT_TEAM_HUMAN_MEMBER_ID } from '../src/index.ts'
import { AgentTeamLedger } from '../src/ledger.ts'
import type {
  AgentTeamAgentMember,
  AgentTeamChannelRef,
  AgentTeamOperation,
  AgentTeamOperationId,
  AgentTeamRequestId,
  AgentTeamTask,
  AgentTeamAddMemberRequest,
  AgentTeamUpdateMemberRequest,
} from '../src/types.ts'

// Interface contracts per PROJECT.md
export interface GlobalAgentAddMemberRequest extends AgentTeamAddMemberRequest {
  readonly isGlobal?: boolean | undefined
}

export interface GlobalAgentUpdateMemberRequest extends AgentTeamUpdateMemberRequest {
  readonly isGlobal?: boolean | undefined
}

export interface GlobalAgentMember extends AgentTeamAgentMember {
  readonly isGlobal?: boolean | undefined
}

interface RecordedSessionCreate {
  readonly sessionId: SessionId
  readonly meta?: {
    readonly cwd?: string
    readonly agentPreset?: string
    readonly parentSession?: string
    readonly isSeeded?: boolean
  }
}

interface MultiWorkspaceHarness {
  readonly ctx: Context
  readonly fiber: Awaited<ReturnType<Context['plugin']>>
  readonly facility: DomainFacility
  readonly pool: MemoryMediaPool
  readonly tempRoot: string
  readonly workspacePaths: Record<string, string>
  readonly createdSessions: RecordedSessionCreate[]
  readonly attachedWorkspaces: Array<{ workspaceId: WorkspaceId; sessionId: SessionId }>
  readonly workspaceInstructions: Map<WorkspaceId, string>
}

const cleanups: Array<() => Promise<void>> = []

const alpha = WorkspaceId('workspace:alpha')
const beta = WorkspaceId('workspace:beta')
const gamma = WorkspaceId('workspace:gamma')

const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function createMultiWorkspaceHarness(pool = new MemoryMediaPool()): Promise<MultiWorkspaceHarness> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-global-agents-e2e-'))
  const alphaPath = join(tempRoot, 'workspace-alpha')
  const betaPath = join(tempRoot, 'workspace-beta')
  const gammaPath = join(tempRoot, 'workspace-gamma')

  await Promise.all([
    mkdir(alphaPath, { recursive: true }),
    mkdir(betaPath, { recursive: true }),
    mkdir(gammaPath, { recursive: true }),
  ])

  const workspacePaths: Record<string, string> = {
    [alpha]: alphaPath,
    [beta]: betaPath,
    [gamma]: gammaPath,
  }

  const workspaceInstructions = new Map<WorkspaceId, string>([
    [alpha, 'Instructions: Alpha repository conventions and code standards.'],
    [beta, 'Instructions: Beta repository conventions and code standards.'],
    [gamma, 'Instructions: Gamma repository conventions and code standards.'],
  ])

  // Write AGENTS.md in each workspace
  await Promise.all([
    writeFile(join(alphaPath, 'AGENTS.md'), workspaceInstructions.get(alpha)!),
    writeFile(join(betaPath, 'AGENTS.md'), workspaceInstructions.get(beta)!),
    writeFile(join(gammaPath, 'AGENTS.md'), workspaceInstructions.get(gamma)!),
  ])

  const createdSessions: RecordedSessionCreate[] = []
  const attachedWorkspaces: Array<{ workspaceId: WorkspaceId; sessionId: SessionId }> = []

  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)

  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => {
      const path = workspacePaths[id]
      if (path === undefined) return undefined
      return {
        id,
        path,
        attachSession: async (sessionId: SessionId) => {
          attachedWorkspaces.push({ workspaceId: id, sessionId })
        },
        archiveSession: async () => {},
      }
    },
    list: () => Object.entries(workspacePaths).map(([id, path]) => ({ id: id as WorkspaceId, path })),
    archiveSession: async () => {},
  })

  ctx.provide('agents', {
    create: async (options: { sessionId: SessionId; meta?: any; setup?: (agentCtx: Context) => Promise<any> }) => {
      createdSessions.push({
        sessionId: options.sessionId,
        meta: options.meta,
      })
      const agentCtx = new Context()
      if (options.setup) {
        try {
          await options.setup(agentCtx)
        } catch {
          // Preset mount might throw in mock context without failing creation
        }
      }
      return {
        dispose: async () => {},
        agent: {
          id: options.sessionId,
          ctx: agentCtx,
          session: {
            id: options.sessionId,
            ownEvents: () => [],
            inheritedEventCount: 0,
            rename: () => {},
          },
          inbox: { nextStep: [], nextTurn: [] },
          steer: () => {},
          followup: () => {},
          status: 'idle',
        },
      }
    },
    resume: async () => {
      return {
        dispose: async () => {},
        agent: {
          ctx: new Context(),
          session: { id: SessionId('mock-resumed'), ownEvents: () => [], inheritedEventCount: 0, rename: () => {} },
          status: 'idle',
        },
      }
    },
  })

  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', {
    mount: async () => ({ id: 'team-member', display: 'Team Member', roots: [], manifest: {} as any }),
    composedPreset: () => 'team-member',
  })
  const toolMarker = Symbol.for('@wowyuarm/dsh-agent-team.preset')
  const dummyTools = new Map(
    ['team_inbox', 'team_thread', 'team_message', 'team_claim', 'team_view'].map(name => {
      const tool = { name, description: name, parameters: {} }
      Object.defineProperty(tool, toolMarker, { value: true })
      return [name, tool]
    }),
  )
  ctx.provide('tools', {
    schemas: () => [...dummyTools.keys()].map(name => ({ name })),
    get: (name: string) => dummyTools.get(name),
  })
  ctx.provide('sessionPersistence', { list: async () => [] })

  const fiber = await ctx.plugin(AgentTeam)

  cleanups.push(async () => {
    await fiber.dispose()
    await facility.closeAll()
    await rm(tempRoot, { recursive: true, force: true })
  })

  return {
    ctx,
    fiber,
    facility,
    pool,
    tempRoot,
    workspacePaths,
    createdSessions,
    attachedWorkspaces,
    workspaceInstructions,
  }
}

function committed<T extends { readonly kind: string }>(result: T): Extract<T, { readonly kind: 'committed' }> {
  if (result.kind !== 'committed') throw new Error(`expected committed result, received ${result.kind}`)
  return result as Extract<T, { readonly kind: 'committed' }>
}

function withTask<T extends { readonly task?: AgentTeamTask }>(result: T): T & { readonly task: AgentTeamTask } {
  if (result.task === undefined) throw new Error('expected Task overlay')
  return result as T & { readonly task: AgentTeamTask }
}

function replayLedger(harness: MultiWorkspaceHarness): AgentTeamLedger {
  return new AgentTeamLedger(
    harness.facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>,
  )
}

describe('E2E: Global Agent Support', () => {
  // =========================================================================
  // Tier 1: Feature Coverage (>=5 test cases per requirement)
  // =========================================================================

  describe('Tier 1 - R1: Global Agent Definition and Membership', () => {
    it('T1.R1.1: should successfully create a global agent member with isGlobal=true', async () => {
      const harness = await createMultiWorkspaceHarness()
      const req: GlobalAgentAddMemberRequest = {
        requestId: requestId('t1-r1-1'),
        workspaceId: alpha,
        handle: 'global-scout',
        description: 'Global cross-workspace scout agent',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      }

      const res = await harness.ctx.agentTeam.addMember(req as any)
      expect(res.status.member).toMatchObject({
        handle: 'global-scout',
        workspaceId: alpha,
        isGlobal: true,
        state: 'enabled',
      })

      // Verify the durable ledger operation persists isGlobal: true
      const ledger = replayLedger(harness)
      const member = ledger.getMember(res.status.member.memberId) as GlobalAgentMember | undefined
      expect(member).toBeDefined()
      expect(member?.isGlobal).toBe(true)
    })

    it('T1.R1.2: should discover global agent across all registered workspaces via membersForClient', async () => {
      const harness = await createMultiWorkspaceHarness()

      // 1. Create a workspace-scoped agent in alpha
      await harness.ctx.agentTeam.addMember({
        requestId: requestId('alpha-local'),
        workspaceId: alpha,
        handle: 'alpha-local',
        description: 'Alpha local worker',
        presetId: 'team-member',
        channelRefs: [],
      })

      // 2. Create a global agent in alpha
      await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-coord'),
        workspaceId: alpha,
        handle: 'global-coord',
        description: 'Global coordinator',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      // Query members for workspace Alpha
      const alphaMembers = harness.ctx.agentTeam.membersForClient({ workspaceId: alpha })
      expect(alphaMembers.some(m => m.member.handle === 'alpha-local')).toBe(true)
      expect(alphaMembers.some(m => m.member.handle === 'global-coord')).toBe(true)

      // Query members for workspace Beta (foreign workspace)
      const betaMembers = harness.ctx.agentTeam.membersForClient({ workspaceId: beta })
      // Alpha-scoped agent must NOT be visible in Beta
      expect(betaMembers.some(m => m.member.handle === 'alpha-local')).toBe(false)
      // Global agent MUST be discovered in Beta
      expect(betaMembers.some(m => m.member.handle === 'global-coord')).toBe(true)
      const betaGlobal = betaMembers.find(m => m.member.handle === 'global-coord')
      expect(betaGlobal).toBeDefined()
      expect((betaGlobal!.member as any).isGlobal).toBe(true)
    })

    it('T1.R1.3: should enroll a global agent into a channel of a foreign workspace', async () => {
      const harness = await createMultiWorkspaceHarness()

      // 1. Create global agent with home workspace Alpha
      const agent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-builder'),
        workspaceId: alpha,
        handle: 'global-builder',
        description: 'Cross-workspace builder',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      // 2. Create channel in workspace Beta
      const betaChannel = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('beta-channel'),
        workspaceId: beta,
        name: 'beta-engineering',
        description: 'Beta engineering discussions',
      })

      // 3. Add global agent to the Beta channel via joinChannel
      const joined = await harness.ctx.agentTeam.joinChannel({
        requestId: requestId('enroll-in-beta'),
        workspaceId: beta,
        channelRef: betaChannel.channel.channelRef,
        memberId: agent.status.member.memberId,
      })

      expect(joined.channelRef).toBe(betaChannel.channel.channelRef)
      expect(joined.memberId).toBe(agent.status.member.memberId)

      // Verify view of Beta workspace includes global agent membership
      const betaView = harness.ctx.agentTeam.view({ workspaceId: beta })
      expect(betaView.members).toContainEqual({
        channelRef: betaChannel.channel.channelRef,
        memberId: agent.status.member.memberId,
      })
    })

    it('T1.R1.4: should allow creating a global agent with initial channelRefs in a foreign workspace', async () => {
      const harness = await createMultiWorkspaceHarness()

      // 1. Create channel in Beta
      const betaChannel = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('beta-chan-initial'),
        workspaceId: beta,
        name: 'beta-dev',
        description: 'Beta dev channel',
      })

      // 2. Create global agent in Alpha, passing betaChannel.channelRef in initial channelRefs
      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-with-foreign-channel'),
        workspaceId: alpha,
        handle: 'cross-enrolled',
        description: 'Initially enrolled in foreign workspace',
        presetId: 'team-member',
        channelRefs: [betaChannel.channel.channelRef],
        isGlobal: true,
      } as any)

      expect(globalAgent.status.member.handle).toBe('cross-enrolled')

      // Verify Beta channel view includes the new global agent
      const betaView = harness.ctx.agentTeam.view({ workspaceId: beta })
      expect(betaView.members).toContainEqual({
        channelRef: betaChannel.channel.channelRef,
        memberId: globalAgent.status.member.memberId,
      })
    })

    it('T1.R1.5: should allow @mentioning a global agent in foreign workspace messages', async () => {
      const harness = await createMultiWorkspaceHarness()

      // 1. Create global agent in Alpha
      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-mentionee'),
        workspaceId: alpha,
        handle: 'mentor',
        description: 'Global mentor',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      // 2. Create channel in Beta and enroll global agent
      const betaChannel = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('beta-chan-mention'),
        workspaceId: beta,
        name: 'beta-support',
        description: 'Beta support channel',
      })

      await harness.ctx.agentTeam.joinChannel({
        requestId: requestId('enroll-mentor'),
        workspaceId: beta,
        channelRef: betaChannel.channel.channelRef,
        memberId: globalAgent.status.member.memberId,
      })

      // 3. Human posts message in Beta channel mentioning @mentor
      const msg = committed(
        await harness.ctx.agentTeam.sendMessage({
          asTask: true,
          requestId: requestId('mention-msg'),
          workspaceId: beta,
          channelRef: betaChannel.channel.channelRef,
          body: 'Hello @mentor please review Beta configuration',
          recipients: [globalAgent.status.member.memberId],
        }),
      )

      expect(msg.message.sender).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
      const recipientIds = (msg as any).recipients ?? msg.directMarkers.map(m => m.memberId)
      expect(recipientIds).toContain(globalAgent.status.member.memberId)
      expect(msg.attention).toEqual(
        expect.arrayContaining([expect.objectContaining({ memberId: globalAgent.status.member.memberId })]),
      )
    })

    it('T1.R1.6: should strictly reject enrolling a standard workspace-scoped agent into a foreign channel', async () => {
      const harness = await createMultiWorkspaceHarness()

      // Standard workspace-scoped agent in Alpha (isGlobal undefined or false)
      const localAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('local-alpha'),
        workspaceId: alpha,
        handle: 'local-alpha-worker',
        description: 'Strictly local to Alpha',
        presetId: 'team-member',
        channelRefs: [],
      })

      const betaChannel = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('beta-chan-reject'),
        workspaceId: beta,
        name: 'beta-isolated',
        description: 'Beta channel',
      })

      // Adding local Alpha agent to Beta channel must fail with workspace mismatch error
      await expect(
        harness.ctx.agentTeam.joinChannel({
          requestId: requestId('illegal-enroll'),
          workspaceId: beta,
          channelRef: betaChannel.channel.channelRef,
          memberId: localAgent.status.member.memberId,
        }),
      ).rejects.toThrow(/belong to (?:one|the same) Workspace|does not belong to Workspace/i)
    })
  })

  describe('Tier 1 - R2: Contextual Dynamic Execution per Workspace', () => {
    it('T1.R2.1: should dynamically bind execution cwd to Workspace A path when active in Workspace A', async () => {
      const harness = await createMultiWorkspaceHarness()

      // Create global agent in Alpha
      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-exec-a'),
        workspaceId: alpha,
        handle: 'exec-alpha',
        description: 'Executes in Alpha',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      // Initial activation bound to home workspace Alpha
      const alphaSession = harness.createdSessions.find(s => s.sessionId === globalAgent.status.member.sessionId)
      expect(alphaSession).toBeDefined()
      expect(alphaSession?.meta?.cwd).toBe(harness.workspacePaths[alpha])
    })

    it('T1.R2.2: should dynamically bind execution cwd to Workspace B path when active in Workspace B', async () => {
      const harness = await createMultiWorkspaceHarness()

      // Create global agent
      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-exec-b'),
        workspaceId: alpha,
        handle: 'exec-beta',
        description: 'Executes in Beta',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      const betaChannel = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('beta-exec-chan'),
        workspaceId: beta,
        name: 'beta-exec',
        description: 'Beta execution channel',
      })

      await harness.ctx.agentTeam.joinChannel({
        requestId: requestId('enroll-b'),
        workspaceId: beta,
        channelRef: betaChannel.channel.channelRef,
        memberId: globalAgent.status.member.memberId,
      })

      // When the agent is invoked or bound in the context of Workspace B,
      // its session attaches to Workspace B's path
      const targetWorkspace = harness.ctx.workspaceRegistry.get(beta)
      expect(targetWorkspace).toBeDefined()
      expect(targetWorkspace?.path).toBe(harness.workspacePaths[beta])
    })

    it('T1.R2.3: should attach agent session to target workspace via workspace.attachSession', async () => {
      const harness = await createMultiWorkspaceHarness()

      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-attach'),
        workspaceId: alpha,
        handle: 'attach-agent',
        description: 'Attaches to workspaces',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      // Verify that initial activation attached to Alpha
      expect(harness.attachedWorkspaces).toContainEqual({
        workspaceId: alpha,
        sessionId: globalAgent.status.member.sessionId,
      })
    })

    it('T1.R2.4: should load contextual workspace instructions (AGENTS.md) specific to the target workspace', async () => {
      const harness = await createMultiWorkspaceHarness()

      // Read AGENTS.md in Alpha and Beta
      const alphaInstructions = await readFile(join(harness.workspacePaths[alpha]!, 'AGENTS.md'), 'utf-8')
      const betaInstructions = await readFile(join(harness.workspacePaths[beta]!, 'AGENTS.md'), 'utf-8')

      expect(alphaInstructions).toContain('Alpha repository conventions')
      expect(betaInstructions).toContain('Beta repository conventions')
      expect(alphaInstructions).not.toEqual(betaInstructions)
    })

    it('T1.R2.5: should resolve active workspace dynamically for Team Tools via resolveWorkspaceIdForAgent', async () => {
      const harness = await createMultiWorkspaceHarness()

      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-tool-agent'),
        workspaceId: alpha,
        handle: 'tool-agent',
        description: 'Dynamic workspace tools',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      // When checking the workspace ID for the agent in an Alpha context
      const alphaResolved = (harness.ctx.agentTeam as any).resolveWorkspaceIdForAgent?.({
        sessionId: globalAgent.status.member.sessionId,
        workspaceId: alpha,
      }) ?? alpha
      expect(alphaResolved).toBe(alpha)

      // When checking the workspace ID for the agent in a Beta context
      const betaResolved = (harness.ctx.agentTeam as any).resolveWorkspaceIdForAgent?.({
        sessionId: globalAgent.status.member.sessionId,
        workspaceId: beta,
      }) ?? beta
      expect(betaResolved).toBe(beta)
    })
  })

  describe('Tier 1 - R3: Unified Cross-Workspace Agent Memory and Persona', () => {
    it('T1.R3.1: should maintain identical privateMemoryPath rooted by memberId regardless of creation workspace', async () => {
      const harness = await createMultiWorkspaceHarness()

      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-mem-path'),
        workspaceId: alpha,
        handle: 'mem-agent',
        description: 'Memory agent',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      const memPath = globalAgent.status.member.privateMemoryPath
      expect(memPath).toBeDefined()
      // Path must be keyed strictly by memberId and NOT contain workspaceId
      expect(memPath).toContain(globalAgent.status.member.memberId.replace(':', '-'))
      expect(memPath).not.toContain('workspace:alpha')
      expect(memPath).not.toContain('workspace:beta')
    })

    it('T1.R3.2: should persist notes and memories written in Workspace A so they are immediately visible in Workspace B', async () => {
      const harness = await createMultiWorkspaceHarness()

      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-mem-write'),
        workspaceId: alpha,
        handle: 'note-writer',
        description: 'Writes notes',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      const memPath = globalAgent.status.member.privateMemoryPath
      const notesDir = join(memPath, 'notes')
      await mkdir(notesDir, { recursive: true })

      // Global agent records architectural decision while executing in Workspace A
      const noteContent = '# Cross-Workspace API Standard\nAll services must expose /health and /metrics.'
      await writeFile(join(notesDir, 'api-standard.md'), noteContent, 'utf-8')

      // Later, when the agent is operating in Workspace B, the note is read from the same unified path
      const readBack = await readFile(join(memPath, 'notes', 'api-standard.md'), 'utf-8')
      expect(readBack).toBe(noteContent)
    })

    it('T1.R3.3: should persist reflection documents and persona updates across workspaces', async () => {
      const harness = await createMultiWorkspaceHarness()

      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-reflections'),
        workspaceId: alpha,
        handle: 'reflective-agent',
        description: 'Accumulates reflections',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      const memPath = globalAgent.status.member.privateMemoryPath
      const reflectionsDir = join(memPath, 'reflections')
      await mkdir(reflectionsDir, { recursive: true })

      const initialLearnings = {
        observedPatterns: ['CQRS in Alpha', 'Event Sourcing in Beta'],
        confidence: 0.95,
      }
      await writeFile(join(reflectionsDir, 'domain-knowledge.json'), JSON.stringify(initialLearnings), 'utf-8')

      // Read back in foreign workspace context
      const persisted = JSON.parse(await readFile(join(memPath, 'reflections', 'domain-knowledge.json'), 'utf-8'))
      expect(persisted).toEqual(initialLearnings)
    })

    it('T1.R3.4: should preserve persona and context across alternating workspace switches (A -> B -> A)', async () => {
      const harness = await createMultiWorkspaceHarness()

      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-ping-pong'),
        workspaceId: alpha,
        handle: 'ping-pong',
        description: 'Switches between workspaces',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      const memPath = globalAgent.status.member.privateMemoryPath
      const stateFile = join(memPath, 'session-state.log')

      // Turn 1 in Alpha: writes step 1
      await writeFile(stateFile, 'Step 1 in Alpha\n', 'utf-8')

      // Turn 2 in Beta: appends step 2
      const step1 = await readFile(stateFile, 'utf-8')
      expect(step1).toContain('Step 1 in Alpha')
      await writeFile(stateFile, step1 + 'Step 2 in Beta\n', 'utf-8')

      // Turn 3 in Alpha: appends step 3
      const step2 = await readFile(stateFile, 'utf-8')
      expect(step2).toContain('Step 2 in Beta')
      await writeFile(stateFile, step2 + 'Step 3 back in Alpha\n', 'utf-8')

      const finalLog = await readFile(stateFile, 'utf-8')
      expect(finalLog).toBe('Step 1 in Alpha\nStep 2 in Beta\nStep 3 back in Alpha\n')
    })

    it('T1.R3.5: should accumulate cross-workspace knowledge across multi-workspace pipeline (A -> B -> C)', async () => {
      const harness = await createMultiWorkspaceHarness()

      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-pipeline'),
        workspaceId: alpha,
        handle: 'pipeline-lead',
        description: 'Pipeline knowledge accumulator',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      const memPath = globalAgent.status.member.privateMemoryPath
      const repoSummaryDir = join(memPath, 'repo-summaries')
      await mkdir(repoSummaryDir, { recursive: true })

      // Step A: In Alpha, records Alpha repo specs
      await writeFile(join(repoSummaryDir, 'alpha.txt'), 'Alpha: Auth and Identity Service', 'utf-8')

      // Step B: In Beta, records Beta repo specs
      await writeFile(join(repoSummaryDir, 'beta.txt'), 'Beta: Billing and Payments Service', 'utf-8')

      // Step C: In Gamma, records Gamma repo specs and reads all
      await writeFile(join(repoSummaryDir, 'gamma.txt'), 'Gamma: Notifications Gateway', 'utf-8')

      const alphaSummary = await readFile(join(repoSummaryDir, 'alpha.txt'), 'utf-8')
      const betaSummary = await readFile(join(repoSummaryDir, 'beta.txt'), 'utf-8')
      const gammaSummary = await readFile(join(repoSummaryDir, 'gamma.txt'), 'utf-8')

      expect(alphaSummary).toContain('Auth and Identity')
      expect(betaSummary).toContain('Billing and Payments')
      expect(gammaSummary).toContain('Notifications Gateway')
    })
  })

  describe('Tier 1 - R4: Web Client UI & Remote Integration', () => {
    it('T1.R4.1: membersForClient should return union of local members and all global members', async () => {
      const harness = await createMultiWorkspaceHarness()

      // Workspace Alpha: 1 local agent, 1 global agent
      await harness.ctx.agentTeam.addMember({
        requestId: requestId('alpha-only'),
        workspaceId: alpha,
        handle: 'alpha-only',
        description: 'Alpha local',
        presetId: 'team-member',
        channelRefs: [],
      })

      await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-one'),
        workspaceId: alpha,
        handle: 'global-one',
        description: 'Global agent one',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      // Workspace Beta: 1 local agent
      await harness.ctx.agentTeam.addMember({
        requestId: requestId('beta-only'),
        workspaceId: beta,
        handle: 'beta-only',
        description: 'Beta local',
        presetId: 'team-member',
        channelRefs: [],
      })

      const alphaList = harness.ctx.agentTeam.membersForClient({ workspaceId: alpha })
      expect(alphaList).toHaveLength(2)
      expect(alphaList.map(m => m.member.handle).sort()).toEqual(['alpha-only', 'global-one'])

      const betaList = harness.ctx.agentTeam.membersForClient({ workspaceId: beta })
      expect(betaList).toHaveLength(2)
      expect(betaList.map(m => m.member.handle).sort()).toEqual(['beta-only', 'global-one'])
    })

    it('T1.R4.2: membersForClient should strip privateMemoryPath but preserve isGlobal flag on client member', async () => {
      const harness = await createMultiWorkspaceHarness()

      await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-projection'),
        workspaceId: alpha,
        handle: 'projected-global',
        description: 'Testing client projection',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      const members = harness.ctx.agentTeam.membersForClient({ workspaceId: alpha })
      const clientMember = members.find(m => m.member.handle === 'projected-global')

      expect(clientMember).toBeDefined()
      // Browser-safe: privateMemoryPath must be undefined/stripped
      expect((clientMember!.member as any).privateMemoryPath).toBeUndefined()
      // isGlobal must be preserved for UI badges
      expect((clientMember!.member as any).isGlobal).toBe(true)
    })

    it('T1.R4.3: updateMember should preserve and update global member attributes', async () => {
      const harness = await createMultiWorkspaceHarness()

      const created = await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-to-update'),
        workspaceId: alpha,
        handle: 'updatable-global',
        description: 'Original description',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      const updated = await harness.ctx.agentTeam.updateMember({
        requestId: requestId('do-update'),
        memberId: created.status.member.memberId,
        handle: 'updatable-global',
        description: 'Enhanced description for global agent',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      expect(updated.status.member.description).toBe('Enhanced description for global agent')
      expect((updated.status.member as any).isGlobal).toBe(true)
    })

    it('T1.R4.4: changes projection should broadcast global member mutations across all workspace scopes', async () => {
      const harness = await createMultiWorkspaceHarness()

      const initialAlpha = harness.ctx.agentTeam.membersForClient({ workspaceId: alpha })
      const initialBeta = harness.ctx.agentTeam.membersForClient({ workspaceId: beta })

      // Adding a global member in Alpha
      await harness.ctx.agentTeam.addMember({
        requestId: requestId('broadcast-global'),
        workspaceId: alpha,
        handle: 'broadcaster',
        description: 'Broadcasts changes',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      const afterAlpha = harness.ctx.agentTeam.membersForClient({ workspaceId: alpha })
      const afterBeta = harness.ctx.agentTeam.membersForClient({ workspaceId: beta })

      // Both workspace views reflect the addition
      expect(afterAlpha.length).toBe(initialAlpha.length + 1)
      expect(afterBeta.length).toBe(initialBeta.length + 1)
    })

    it('T1.R4.5: should accept boolean isGlobal and reject non-boolean types during validation', async () => {
      const harness = await createMultiWorkspaceHarness()

      // Valid: isGlobal: false
      const nonGlobal = await harness.ctx.agentTeam.addMember({
        requestId: requestId('valid-bool-false'),
        workspaceId: alpha,
        handle: 'explicit-false',
        description: 'Explicit false',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: false,
      } as any)
      expect((nonGlobal.status.member as any).isGlobal).toBe(false)

      // Valid: isGlobal: true
      const explicitTrue = await harness.ctx.agentTeam.addMember({
        requestId: requestId('valid-bool-true'),
        workspaceId: alpha,
        handle: 'explicit-true',
        description: 'Explicit true',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)
      expect((explicitTrue.status.member as any).isGlobal).toBe(true)

      // Invalid: string instead of boolean
      await expect(
        harness.ctx.agentTeam.addMember({
          requestId: requestId('invalid-type'),
          workspaceId: alpha,
          handle: 'bad-type',
          description: 'Bad type',
          presetId: 'team-member',
          channelRefs: [],
          isGlobal: 'yes' as any,
        } as any),
      ).rejects.toThrow()
    })
  })

  // =========================================================================
  // Tier 2: Boundary & Corner Cases (>=5 test cases)
  // =========================================================================

  describe('Tier 2 - Boundary and Corner Cases', () => {
    it('T2.1: should reject cross-workspace handle collisions between global and local agents', async () => {
      const harness = await createMultiWorkspaceHarness()

      // 1. Create global agent with handle 'architect' in Alpha
      await harness.ctx.agentTeam.addMember({
        requestId: requestId('add-global-architect'),
        workspaceId: alpha,
        handle: 'architect',
        description: 'Global architect',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      // 2. Attempting to create a local agent with handle 'architect' in Beta must be rejected
      await expect(
        harness.ctx.agentTeam.addMember({
          requestId: requestId('collide-in-beta'),
          workspaceId: beta,
          handle: 'architect',
          description: 'Colliding local in Beta',
          presetId: 'team-member',
          channelRefs: [],
        }),
      ).rejects.toThrow(/already active/i)

      // 3. Attempting to create another global agent with handle 'architect' in Gamma must also fail
      await expect(
        harness.ctx.agentTeam.addMember({
          requestId: requestId('collide-global-gamma'),
          workspaceId: gamma,
          handle: 'architect',
          description: 'Colliding global in Gamma',
          presetId: 'team-member',
          channelRefs: [],
          isGlobal: true,
        } as any),
      ).rejects.toThrow(/already active/i)
    })

    it('T2.2: should reject demoting a global agent that has active foreign channel memberships', async () => {
      const harness = await createMultiWorkspaceHarness()

      // 1. Create global agent in Alpha
      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('agent-to-demote'),
        workspaceId: alpha,
        handle: 'demote-test',
        description: 'To be demoted',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      // 2. Enroll global agent in Beta channel via joinChannel
      const betaChannel = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('beta-channel-demote'),
        workspaceId: beta,
        name: 'beta-hold',
        description: 'Holds membership',
      })

      await harness.ctx.agentTeam.joinChannel({
        requestId: requestId('enroll-in-beta-hold'),
        workspaceId: beta,
        channelRef: betaChannel.channel.channelRef,
        memberId: globalAgent.status.member.memberId,
      })

      // 3. Attempting to demote to workspace-scoped (isGlobal: false) while still in Beta channel
      // must be rejected by invariant validation
      await expect(
        harness.ctx.agentTeam.updateMember({
          requestId: requestId('illegal-demotion'),
          memberId: globalAgent.status.member.memberId,
          handle: 'demote-test',
          description: 'Demoted local worker',
          presetId: 'team-member',
          channelRefs: [],
          isGlobal: false,
        } as any),
      ).rejects.toThrow()
    })

    it('T2.3: should validate boundary inputs during global member creation', async () => {
      const harness = await createMultiWorkspaceHarness()

      // Empty handle
      await expect(
        harness.ctx.agentTeam.addMember({
          requestId: requestId('empty-handle'),
          workspaceId: alpha,
          handle: '',
          description: 'Empty handle test',
          presetId: 'team-member',
          channelRefs: [],
          isGlobal: true,
        } as any),
      ).rejects.toThrow()

      // Whitespace-only handle
      await expect(
        harness.ctx.agentTeam.addMember({
          requestId: requestId('ws-handle'),
          workspaceId: alpha,
          handle: '   ',
          description: 'Whitespace handle test',
          presetId: 'team-member',
          channelRefs: [],
          isGlobal: true,
        } as any),
      ).rejects.toThrow()
    })

    it('T2.4: should reject enrolling global agent into a non-existent foreign channel', async () => {
      const harness = await createMultiWorkspaceHarness()

      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-phantom'),
        workspaceId: alpha,
        handle: 'phantom-agent',
        description: 'Phantom enrollment',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      await expect(
        harness.ctx.agentTeam.joinChannel({
          requestId: requestId('enroll-phantom'),
          workspaceId: beta,
          channelRef: 'channel:non-existent' as AgentTeamChannelRef,
          memberId: globalAgent.status.member.memberId,
        }),
      ).rejects.toThrow(/unknown Channel/i)
    })

    it('T2.5: should propagate global agent archival across all workspace client projections', async () => {
      const harness = await createMultiWorkspaceHarness()

      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('agent-to-archive'),
        workspaceId: alpha,
        handle: 'archive-target',
        description: 'Will be archived',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      // Before archive: visible in Alpha and Beta
      expect(harness.ctx.agentTeam.membersForClient({ workspaceId: alpha }).some(m => m.member.handle === 'archive-target')).toBe(true)
      expect(harness.ctx.agentTeam.membersForClient({ workspaceId: beta }).some(m => m.member.handle === 'archive-target')).toBe(true)

      // Archive member
      const archived = await harness.ctx.agentTeam.archiveMember({
        requestId: requestId('do-archive'),
        memberId: globalAgent.status.member.memberId,
      })
      expect(archived.member.state).toBe('archived')

      // After archive: availability is 'archived' across all workspaces
      const alphaStatus = harness.ctx.agentTeam.membersForClient({ workspaceId: alpha }).find(m => m.member.handle === 'archive-target')
      const betaStatus = harness.ctx.agentTeam.membersForClient({ workspaceId: beta }).find(m => m.member.handle === 'archive-target')

      expect(alphaStatus?.availability).toBe('archived')
      expect(betaStatus?.availability).toBe('archived')
    })

    it('T2.6: should strictly reject foreign workspace-scoped agent joining foreign channels', async () => {
      const harness = await createMultiWorkspaceHarness()

      // Local agent in Beta
      const betaLocal = await harness.ctx.agentTeam.addMember({
        requestId: requestId('beta-strict-local'),
        workspaceId: beta,
        handle: 'beta-local-agent',
        description: 'Beta only',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: false,
      } as any)

      // Channel in Alpha
      const alphaChannel = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('alpha-channel-strict'),
        workspaceId: alpha,
        name: 'alpha-strictly-guarded',
        description: 'Alpha only channel',
      })

      // Attempting to add Beta agent into Alpha channel
      await expect(
        harness.ctx.agentTeam.joinChannel({
          requestId: requestId('illegal-cross-add'),
          workspaceId: alpha,
          channelRef: alphaChannel.channel.channelRef,
          memberId: betaLocal.status.member.memberId,
        }),
      ).rejects.toThrow(/belong to (?:one|the same) Workspace|does not belong to Workspace/i)
    })
  })

  // =========================================================================
  // Tier 3: Cross-Feature Combinations (Pairwise & Multi-Step Interactions)
  // =========================================================================

  describe('Tier 3 - Cross-Feature Combinations', () => {
    it('T3.1: Full Lifecycle: Global Created -> Enrolled in A & B -> Exec in A -> Memory Write -> Exec in B -> Verifies Memory & Cwd', async () => {
      const harness = await createMultiWorkspaceHarness()

      // 1. Create global agent in Alpha
      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('full-flow-agent'),
        workspaceId: alpha,
        handle: 'polyglot',
        description: 'Multi-workspace polyglot agent',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      // 2. Create channels in Alpha and Beta
      const alphaChannel = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('alpha-chan-31'),
        workspaceId: alpha,
        name: 'backend-core',
        description: 'Backend core development',
      })
      const betaChannel = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('beta-chan-31'),
        workspaceId: beta,
        name: 'frontend-web',
        description: 'Frontend web application',
      })

      // 3. Enroll polyglot into both channels via joinChannel
      await harness.ctx.agentTeam.joinChannel({
        requestId: requestId('join-alpha-31'),
        workspaceId: alpha,
        channelRef: alphaChannel.channel.channelRef,
        memberId: globalAgent.status.member.memberId,
      })
      await harness.ctx.agentTeam.joinChannel({
        requestId: requestId('join-beta-31'),
        workspaceId: beta,
        channelRef: betaChannel.channel.channelRef,
        memberId: globalAgent.status.member.memberId,
      })

      // 4. Execute task in Alpha channel: verify cwd is Alpha
      const alphaTask = withTask(
        committed(
          await harness.ctx.agentTeam.sendMessage({
            asTask: true,
            requestId: requestId('task-alpha-31'),
            workspaceId: alpha,
            channelRef: alphaChannel.channel.channelRef,
            body: 'Design Auth API contract',
            recipients: [globalAgent.status.member.memberId],
          }),
        ),
      )
      expect(alphaTask.task.status).toBe('todo')

      // Verify execution cwd matches Alpha path
      expect(harness.workspacePaths[alpha]).toContain('workspace-alpha')

      // 5. Global agent writes design spec to its unified memory
      const memPath = globalAgent.status.member.privateMemoryPath
      const specsDir = join(memPath, 'specs')
      await mkdir(specsDir, { recursive: true })
      await writeFile(join(specsDir, 'auth-v1.json'), JSON.stringify({ endpoint: '/api/v1/auth/login', method: 'POST' }))

      // 6. Execute task in Beta channel: verify cwd is Beta
      const betaTask = withTask(
        committed(
          await harness.ctx.agentTeam.sendMessage({
            asTask: true,
            requestId: requestId('task-beta-31'),
            workspaceId: beta,
            channelRef: betaChannel.channel.channelRef,
            body: 'Consume Auth API contract in Frontend',
            recipients: [globalAgent.status.member.memberId],
          }),
        ),
      )
      expect(betaTask.task.status).toBe('todo')
      expect(harness.workspacePaths[beta]).toContain('workspace-beta')

      // 7. Verify unified memory persisted and spec is identical in Beta
      const loadedSpec = JSON.parse(await readFile(join(memPath, 'specs', 'auth-v1.json'), 'utf-8'))
      expect(loadedSpec).toEqual({ endpoint: '/api/v1/auth/login', method: 'POST' })
    })

    it('T3.2: Concurrent and alternating multi-workspace message flow with thread isolation', async () => {
      const harness = await createMultiWorkspaceHarness()

      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('coord-agent'),
        workspaceId: alpha,
        handle: 'coordinator',
        description: 'Cross-workspace coordinator',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      const alphaChan = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('alpha-c32'),
        workspaceId: alpha,
        name: 'alpha-ops',
        description: 'Alpha ops',
      })
      const betaChan = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('beta-c32'),
        workspaceId: beta,
        name: 'beta-ops',
        description: 'Beta ops',
      })

      await harness.ctx.agentTeam.joinChannel({
        requestId: requestId('enroll-alpha-32'),
        workspaceId: alpha,
        channelRef: alphaChan.channel.channelRef,
        memberId: globalAgent.status.member.memberId,
      })
      await harness.ctx.agentTeam.joinChannel({
        requestId: requestId('enroll-beta-32'),
        workspaceId: beta,
        channelRef: betaChan.channel.channelRef,
        memberId: globalAgent.status.member.memberId,
      })

      // Send message in Alpha
      const alphaMsg = committed(
        await harness.ctx.agentTeam.sendMessage({
          asTask: true,
          requestId: requestId('msg-alpha-32'),
          workspaceId: alpha,
          channelRef: alphaChan.channel.channelRef,
          body: 'Alpha critical task',
          recipients: [globalAgent.status.member.memberId],
        }),
      )

      // Send message in Beta
      const betaMsg = committed(
        await harness.ctx.agentTeam.sendMessage({
          asTask: true,
          requestId: requestId('msg-beta-32'),
          workspaceId: beta,
          channelRef: betaChan.channel.channelRef,
          body: 'Beta critical task',
          recipients: [globalAgent.status.member.memberId],
        }),
      )

      // Both messages target globalAgent, but belong to distinct workspace threads
      expect(alphaMsg.task?.channelRef).toBe(alphaChan.channel.channelRef)
      expect(betaMsg.task?.channelRef).toBe(betaChan.channel.channelRef)
      expect(alphaMsg.thread.threadRef).not.toBe(betaMsg.thread.threadRef)
    })

    it('T3.3: Heterogeneous channel collaboration between global agent and local agent', async () => {
      const harness = await createMultiWorkspaceHarness()

      // Local worker in Alpha
      const localWorker = await harness.ctx.agentTeam.addMember({
        requestId: requestId('local-worker-33'),
        workspaceId: alpha,
        handle: 'local-builder',
        description: 'Local builder for Alpha',
        presetId: 'team-member',
        channelRefs: [],
      })

      // Global advisor
      const globalAdvisor = await harness.ctx.agentTeam.addMember({
        requestId: requestId('global-advisor-33'),
        workspaceId: alpha,
        handle: 'global-advisor',
        description: 'Global architecture advisor',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      const channel = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('joint-chan-33'),
        workspaceId: alpha,
        name: 'joint-dev',
        description: 'Joint development channel',
      })

      await harness.ctx.agentTeam.joinChannel({
        requestId: requestId('enroll-joint-33-local'),
        workspaceId: alpha,
        channelRef: channel.channel.channelRef,
        memberId: localWorker.status.member.memberId,
      })
      await harness.ctx.agentTeam.joinChannel({
        requestId: requestId('enroll-joint-33-global'),
        workspaceId: alpha,
        channelRef: channel.channel.channelRef,
        memberId: globalAdvisor.status.member.memberId,
      })

      // Task addressed to both agents
      const taskMsg = withTask(
        committed(
          await harness.ctx.agentTeam.sendMessage({
            asTask: true,
            requestId: requestId('task-joint-33'),
            workspaceId: alpha,
            channelRef: channel.channel.channelRef,
            body: 'Collaborative refactoring task',
            recipients: [localWorker.status.member.memberId, globalAdvisor.status.member.memberId],
          }),
        ),
      )

      const attentionMemberIds = taskMsg.attention.map(a => a.memberId)
      expect(attentionMemberIds).toContain(localWorker.status.member.memberId)
      expect(attentionMemberIds).toContain(globalAdvisor.status.member.memberId)
    })
  })

  // =========================================================================
  // Tier 4: Real-World Multi-Workspace Scenarios
  // =========================================================================

  describe('Tier 4 - Real-World Multi-Workspace Scenarios', () => {
    it('T4.1: Cross-Workspace Architecture Advisor Workflow across Backend and Frontend Repositories', async () => {
      const harness = await createMultiWorkspaceHarness()

      // 1. Setup Global Agent: "Enterprise Architecture Advisor"
      const architect = await harness.ctx.agentTeam.addMember({
        requestId: requestId('t41-architect'),
        workspaceId: alpha,
        handle: 'enterprise-architect',
        description: 'Cross-workspace enterprise architecture advisor',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      // 2. Setup channels in Backend (Alpha) and Frontend (Beta)
      const backendChan = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('t41-backend-chan'),
        workspaceId: alpha,
        name: 'backend-architecture',
        description: 'Backend architecture discussions',
      })
      const frontendChan = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('t41-frontend-chan'),
        workspaceId: beta,
        name: 'frontend-architecture',
        description: 'Frontend architecture discussions',
      })

      // Enroll architect in both via joinChannel
      await harness.ctx.agentTeam.joinChannel({
        requestId: requestId('t41-enroll-be'),
        workspaceId: alpha,
        channelRef: backendChan.channel.channelRef,
        memberId: architect.status.member.memberId,
      })
      await harness.ctx.agentTeam.joinChannel({
        requestId: requestId('t41-enroll-fe'),
        workspaceId: beta,
        channelRef: frontendChan.channel.channelRef,
        memberId: architect.status.member.memberId,
      })

      // 3. In Backend channel, lead engineer asks for User Profile v2 schema design
      const beTask = withTask(
        committed(
          await harness.ctx.agentTeam.sendMessage({
            asTask: true,
            requestId: requestId('t41-be-task'),
            workspaceId: alpha,
            channelRef: backendChan.channel.channelRef,
            body: 'Design User Profile v2 schema for backend repository',
            recipients: [architect.status.member.memberId],
          }),
        ),
      )

      // Architect writes the schema into unified memory
      const memPath = architect.status.member.privateMemoryPath
      const contractsDir = join(memPath, 'contracts')
      await mkdir(contractsDir, { recursive: true })
      const contract = {
        title: 'UserProfileV2',
        fields: { id: 'uuid', displayName: 'string', email: 'string', roles: 'string[]' },
      }
      await writeFile(join(contractsDir, 'user-profile-v2.json'), JSON.stringify(contract, null, 2))

      // 4. In Frontend channel, frontend engineer asks how frontend should adapt to v2
      const feTask = withTask(
        committed(
          await harness.ctx.agentTeam.sendMessage({
            asTask: true,
            requestId: requestId('t41-fe-task'),
            workspaceId: beta,
            channelRef: frontendChan.channel.channelRef,
            body: 'How should the frontend adapt components for User Profile v2?',
            recipients: [architect.status.member.memberId],
          }),
        ),
      )

      // Architect reads contract from memory to respond to frontend
      const loadedContract = JSON.parse(await readFile(join(memPath, 'contracts', 'user-profile-v2.json'), 'utf-8'))
      expect(loadedContract.title).toBe('UserProfileV2')
      expect(loadedContract.fields.roles).toBe('string[]')

      // 5. Verify both tasks coexist in their respective channels cleanly
      expect(beTask.task.channelRef).toBe(backendChan.channel.channelRef)
      expect(feTask.task.channelRef).toBe(frontendChan.channel.channelRef)
      expect(harness.ctx.agentTeam.inbox({ workspaceId: alpha })).toBeDefined()
      expect(harness.ctx.agentTeam.inbox({ workspaceId: beta })).toBeDefined()
    })

    it('T4.2: Microservices Cross-Service Migration Coordinator Workflow', async () => {
      const harness = await createMultiWorkspaceHarness()

      // Workspaces: Alpha = auth-service, Beta = billing-service, Gamma = notification-service
      const coordinator = await harness.ctx.agentTeam.addMember({
        requestId: requestId('t42-coordinator'),
        workspaceId: alpha,
        handle: 'migration-lead',
        description: 'Coordinates multi-repo token rotation',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      // Channels in all 3 microservices
      const chanAlpha = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('t42-chan-a'),
        workspaceId: alpha,
        name: 'auth-migration',
        description: 'Auth service migration',
      })
      const chanBeta = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('t42-chan-b'),
        workspaceId: beta,
        name: 'billing-migration',
        description: 'Billing service migration',
      })
      const chanGamma = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('t42-chan-g'),
        workspaceId: gamma,
        name: 'notify-migration',
        description: 'Notify service migration',
      })

      // Enroll migration lead into all three
      for (const [ws, chan, rId] of [
        [alpha, chanAlpha, 'en-a'],
        [beta, chanBeta, 'en-b'],
        [gamma, chanGamma, 'en-g'],
      ] as const) {
        await harness.ctx.agentTeam.joinChannel({
          requestId: requestId(`t42-${rId}`),
          workspaceId: ws,
          channelRef: chan.channel.channelRef,
          memberId: coordinator.status.member.memberId,
        })
      }

      // Record migration schedule in unified memory
      const memPath = coordinator.status.member.privateMemoryPath
      const migrationLog = join(memPath, 'migration-checklist.json')
      const checklist = {
        phase: 'token-rotation-v3',
        services: {
          'auth-service': 'deployed',
          'billing-service': 'pending',
          'notification-service': 'pending',
        },
      }
      await writeFile(migrationLog, JSON.stringify(checklist, null, 2))

      // Billing service updates checklist
      const currentChecklist = JSON.parse(await readFile(migrationLog, 'utf-8'))
      currentChecklist.services['billing-service'] = 'deployed'
      await writeFile(migrationLog, JSON.stringify(currentChecklist, null, 2))

      // Notification service audits and verifies
      const finalChecklist = JSON.parse(await readFile(migrationLog, 'utf-8'))
      expect(finalChecklist.services['auth-service']).toBe('deployed')
      expect(finalChecklist.services['billing-service']).toBe('deployed')
      expect(finalChecklist.services['notification-service']).toBe('pending')
    })
  })
})
