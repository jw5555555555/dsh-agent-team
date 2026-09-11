import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentTeam, { isGlobalMember } from '../src/index.ts'
import { memberMemoryDirectoryName, memberMemoryDirectoryPath } from '../src/member-runtime.ts'
import { teamInbox, teamThread, teamMessage, teamClaim, teamView } from '../../tool-agent-team/src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import type { AgentTeamRequestId } from '../src/types.ts'

interface RecordedSessionCreate {
  readonly sessionId: SessionId
  readonly meta?: {
    readonly cwd?: string
    readonly agentPreset?: string
    readonly parentSession?: string
    readonly isSeeded?: boolean
  } | undefined
}

interface TestHarness {
  readonly ctx: Context
  readonly fiber: Awaited<ReturnType<Context['plugin']>>
  readonly tempRoot: string
  readonly workspacePaths: Record<WorkspaceId, string>
  readonly workspaceInstructions: Record<WorkspaceId, string>
  readonly createdSessions: RecordedSessionCreate[]
  readonly attachedWorkspaces: Array<{ workspaceId: WorkspaceId; sessionId: SessionId }>
  readonly pool: MemoryMediaPool
}

const cleanups: Array<() => Promise<void>> = []

const alpha = WorkspaceId('workspace:alpha')
const beta = WorkspaceId('workspace:beta')
const gamma = WorkspaceId('workspace:gamma')

const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function createHarness(pool = new MemoryMediaPool()): Promise<TestHarness> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-runtime-ctx-test-'))
  const alphaPath = join(tempRoot, 'workspace-alpha')
  const betaPath = join(tempRoot, 'workspace-beta')
  const gammaPath = join(tempRoot, 'workspace-gamma')

  await Promise.all([
    mkdir(alphaPath, { recursive: true }),
    mkdir(betaPath, { recursive: true }),
    mkdir(gammaPath, { recursive: true }),
  ])

  const workspacePaths: Record<WorkspaceId, string> = {
    [alpha]: alphaPath,
    [beta]: betaPath,
    [gamma]: gammaPath,
  }

  const workspaceInstructions: Record<WorkspaceId, string> = {
    [alpha]: '# Alpha Guidelines\nFollow strict TypeScript conventions and avoid any.',
    [beta]: '# Beta Guidelines\nFollow Go conventions and write concise error handling.',
    [gamma]: '# Gamma Guidelines\nFollow Rust conventions and prioritize zero-cost abstractions.',
  }

  // Create workspace AGENTS.md files
  await Promise.all([
    writeFile(join(alphaPath, 'AGENTS.md'), workspaceInstructions[alpha]!),
    writeFile(join(betaPath, 'AGENTS.md'), workspaceInstructions[beta]!),
    writeFile(join(gammaPath, 'AGENTS.md'), workspaceInstructions[gamma]!),
  ])

  const createdSessions: RecordedSessionCreate[] = []
  const attachedWorkspaces: Array<{ workspaceId: WorkspaceId; sessionId: SessionId }> = []
  const liveAgents = new Map<SessionId, Agent>()

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
    create: async (options: { sessionId: SessionId; meta?: { cwd?: string; agentPreset?: string }; setup?: (agentCtx: Context) => Promise<any> }) => {
      createdSessions.push({
        sessionId: options.sessionId,
        ...(options.meta !== undefined ? { meta: options.meta } : {}),
      })
      const agentCtx = ctx.extend()
      if (options.setup) {
        try {
          await options.setup(agentCtx)
        } catch {
          // ignore preset setup errors in mock
        }
      }
      const agent: Agent = {
        id: options.sessionId,
        ctx: agentCtx,
        session: {
          id: options.sessionId,
          header: { cwd: options.meta?.cwd },
          ownEvents: () => [],
          inheritedEventCount: 0,
          rename: () => {},
        } as any,
        inbox: { nextStep: [], nextTurn: [], remove: () => {} } as any,
        steer: () => {},
        followup: () => {},
        status: 'idle',
      } as any
      liveAgents.set(options.sessionId, agent)
      return {
        dispose: async () => {
          liveAgents.delete(options.sessionId)
        },
        agent,
      }
    },
    resume: async (options: { resumeSessionId: SessionId }) => {
      const existing = liveAgents.get(options.resumeSessionId)
      return {
        dispose: async () => {},
        agent: existing ?? ({
          id: options.resumeSessionId,
          ctx: ctx.extend(),
          session: { id: options.resumeSessionId, ownEvents: () => [], inheritedEventCount: 0, rename: () => {} },
          inbox: { nextStep: [], nextTurn: [], remove: () => {} },
          status: 'idle',
        } as any),
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
    tempRoot,
    workspacePaths,
    workspaceInstructions,
    createdSessions,
    attachedWorkspaces,
    pool,
  }
}

describe('Milestone 2: Runtime Execution Context, Dynamic Workspace Binding & Memory', () => {
  describe('Dynamic Workspace Session Binding (F6, F7)', () => {
    it('activates a global agent with cwd bound to target workspace and attaches session', async () => {
      const harness = await createHarness()

      const added = await harness.ctx.agentTeam.addMember({
        requestId: requestId('add-global-1'),
        workspaceId: alpha,
        handle: 'architect',
        description: 'Global cross-workspace architect',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      expect(isGlobalMember(added.status.member)).toBe(true)

      // Initial activation attached to creation workspace Alpha
      expect(harness.attachedWorkspaces).toContainEqual({
        workspaceId: alpha,
        sessionId: added.status.member.sessionId,
      })

      // Check session created with alphaPath
      const alphaSession = harness.createdSessions.find(s => s.sessionId === added.status.member.sessionId)
      expect(alphaSession).toBeDefined()
      expect(alphaSession?.meta?.cwd).toBe(harness.workspacePaths[alpha])

      // Verify instruction loading for Workspace Alpha
      const alphaInstructions = await readFile(join(alphaSession!.meta!.cwd!, 'AGENTS.md'), 'utf-8')
      expect(alphaInstructions).toContain('Alpha Guidelines')
      expect(alphaInstructions).toContain('strict TypeScript')

      // Now reactivate the global agent in Workspace Beta context
      await harness.ctx.agentTeam.reactivateMember(added.status.member.memberId, beta)

      // Verify attached to Beta
      expect(harness.attachedWorkspaces).toContainEqual({
        workspaceId: beta,
        sessionId: added.status.member.sessionId,
      })

      // Find the new session creation for the member
      const betaSession = harness.createdSessions.find(
        (s, idx) => idx > 0 && s.sessionId === added.status.member.sessionId,
      )
      expect(betaSession).toBeDefined()
      expect(betaSession?.meta?.cwd).toBe(harness.workspacePaths[beta])

      // Verify instruction loading for Workspace Beta
      const betaInstructions = await readFile(join(betaSession!.meta!.cwd!, 'AGENTS.md'), 'utf-8')
      expect(betaInstructions).toContain('Beta Guidelines')
      expect(betaInstructions).toContain('Go conventions')
      expect(betaInstructions).not.toEqual(alphaInstructions)
    })

    it('determines the active workspace ID via host.resolveWorkspaceIdForAgent', async () => {
      const harness = await createHarness()

      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('add-global-resolver'),
        workspaceId: alpha,
        handle: 'resolver-agent',
        description: 'Tests workspace resolution',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      const scopedAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('add-scoped-resolver'),
        workspaceId: alpha,
        handle: 'scoped-agent',
        description: 'Scoped to alpha',
        presetId: 'team-member',
        channelRefs: [],
      })

      const host = harness.ctx.agentTeam

      // 1. Explicit workspaceId in agent mock
      expect(host.resolveWorkspaceIdForAgent({ workspaceId: beta })).toBe(beta)

      // 2. Inspecting agent.session.header.cwd against known workspace paths
      const mockAgentInBeta = {
        sessionId: globalAgent.status.member.sessionId,
        session: {
          id: globalAgent.status.member.sessionId,
          header: { cwd: harness.workspacePaths[beta] },
        },
      } as any
      expect(host.resolveWorkspaceIdForAgent(mockAgentInBeta)).toBe(beta)

      const mockAgentInGamma = {
        sessionId: globalAgent.status.member.sessionId,
        session: {
          id: globalAgent.status.member.sessionId,
          header: { cwd: harness.workspacePaths[gamma] },
        },
      } as any
      expect(host.resolveWorkspaceIdForAgent(mockAgentInGamma)).toBe(gamma)

      // 3. Active session attachment lookup
      // Since globalAgent was activated in Alpha, its attached session resolves to Alpha
      const mockAgentActive = {
        sessionId: globalAgent.status.member.sessionId,
        session: { id: globalAgent.status.member.sessionId },
      } as any
      expect(host.resolveWorkspaceIdForAgent(mockAgentActive)).toBe(alpha)

      // 4. Scoped agent always resolves to its designated workspace
      const mockScoped = {
        sessionId: scopedAgent.status.member.sessionId,
        session: { id: scopedAgent.status.member.sessionId },
      } as any
      expect(host.resolveWorkspaceIdForAgent(mockScoped)).toBe(alpha)

      // 5. Unknown session returns undefined
      expect(host.resolveWorkspaceIdForAgent({ sessionId: SessionId('unknown-session') })).toBeUndefined()
    })
  })

  describe('Unified Cross-Workspace Memory & Persona (F8)', () => {
    it('maintains unified private memory path across all workspaces', async () => {
      const harness = await createHarness()

      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('add-global-mem'),
        workspaceId: alpha,
        handle: 'mem-unified',
        description: 'Cross-workspace memory',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      const member = globalAgent.status.member
      const memPath = member.privateMemoryPath

      // Memory directory name is sanitized and keyed strictly by memberId
      const expectedDirName = memberMemoryDirectoryName(member.memberId)
      expect(memPath).toContain(expectedDirName)
      expect(memPath).not.toContain('workspace:alpha')
      expect(memPath).not.toContain('workspace:beta')

      // Path helper produces consistent sanitized path
      const resolvedPath = memberMemoryDirectoryPath(member)
      expect(resolvedPath).toBe(memPath)

      // Write architectural notes in Workspace A
      const notesDir = join(memPath, 'notes')
      await mkdir(notesDir, { recursive: true })
      const noteFile = join(notesDir, 'auth-architecture.md')
      const noteContent = '# Unified Auth Architecture\nShared token verification across all microservices.'
      await writeFile(noteFile, noteContent, 'utf-8')

      // Write reflection in memory.md
      const memoryFile = join(memPath, 'memory.md')
      const memoryContent = '# Persona Memory Index\n- [[notes/auth-architecture.md]] Auth Architecture overview.'
      await writeFile(memoryFile, memoryContent, 'utf-8')

      // Now switch execution context to Workspace B
      await harness.ctx.agentTeam.reactivateMember(member.memberId, beta)

      // Verify that in Workspace B, the exact same files are present and visible
      const readNoteInBeta = await readFile(join(memPath, 'notes', 'auth-architecture.md'), 'utf-8')
      expect(readNoteInBeta).toBe(noteContent)

      const readMemoryInBeta = await readFile(join(memPath, 'memory.md'), 'utf-8')
      expect(readMemoryInBeta).toBe(memoryContent)

      // Writing from Workspace B updates the same unified store
      const updatedMemory = `${memoryContent}\n- Added notes while auditing Workspace B.`
      await writeFile(memoryFile, updatedMemory, 'utf-8')

      // Re-read confirms unified update
      const verifiedUpdate = await readFile(join(memPath, 'memory.md'), 'utf-8')
      expect(verifiedUpdate).toBe(updatedMemory)
    })
  })

  describe('Team Tools Context Resolution (F9)', () => {
    it('dynamically resolves active workspace for all 5 team tools', async () => {
      const harness = await createHarness()

      // Create channels in Alpha and Beta
      const alphaChannel = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('chan-alpha'),
        workspaceId: alpha,
        name: 'alpha-general',
        description: 'Alpha workspace general channel',
      })

      const betaChannel = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('chan-beta'),
        workspaceId: beta,
        name: 'beta-general',
        description: 'Beta workspace general channel',
      })

      // Add global agent enrolled in both channels
      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('add-global-tools'),
        workspaceId: alpha,
        handle: 'tool-navigator',
        description: 'Global tool navigator',
        presetId: 'team-member',
        channelRefs: [alphaChannel.channel.channelRef],
        isGlobal: true,
      } as any)

      await harness.ctx.agentTeam.joinChannel({
        requestId: requestId('enroll-beta'),
        workspaceId: beta,
        channelRef: betaChannel.channel.channelRef,
        memberId: globalAgent.status.member.memberId,
      })

      const host = harness.ctx.agentTeam
      const memberId = globalAgent.status.member.memberId

      // Retrieve the real live Agent handle from host
      const handle = (host as any).handles.get(memberId)
      expect(handle).toBeDefined()
      const liveAgent = handle.agent

      // 1. Initially executing in Alpha (cwd is alphaPath)
      expect(liveAgent.session.header.cwd).toBe(harness.workspacePaths[alpha])
      expect(host.resolveWorkspaceIdForAgent(liveAgent)).toBe(alpha)

      // team_view in Alpha targets Workspace Alpha
      const alphaView = (await teamView.execute({}, { agent: liveAgent, callId: 'call-view-a' } as any)) as any
      expect(alphaView.channels.some((c: any) => c.channelRef === alphaChannel.channel.channelRef)).toBe(true)
      expect(alphaView.channels.some((c: any) => c.channelRef === betaChannel.channel.channelRef)).toBe(false)

      // team_message in Alpha starts thread in Alpha channel
      const alphaMsgResult = (await teamMessage.execute(
        { action: 'start', channelRef: alphaChannel.channel.channelRef, body: 'Hello Alpha from global agent', asTask: true },
        { agent: liveAgent, callId: 'call-msg-a' } as any,
      )) as any
      expect(alphaMsgResult.kind).toBe('committed')
      expect(alphaMsgResult.threadRef).toBeDefined()
      expect(alphaMsgResult.taskRef).toBeDefined()

      // team_inbox in Alpha reads Alpha inbox
      const alphaInbox = (await teamInbox.execute({}, { agent: liveAgent, callId: 'call-inbox-a' } as any)) as any
      expect(alphaInbox).toBeDefined()
      expect(alphaInbox.totalUnreadCount).toBeGreaterThanOrEqual(0)

      // team_thread in Alpha reads thread created in Alpha
      const alphaThreadRead = (await teamThread.execute(
        { action: 'read', threadRef: alphaMsgResult.threadRef },
        { agent: liveAgent, callId: 'call-thread-a' } as any,
      )) as any
      expect(alphaThreadRead.threadRef).toBe(alphaMsgResult.threadRef)

      // team_claim in Alpha lists claims for task in Alpha
      const alphaClaims = (await teamClaim.execute(
        { action: 'list', taskRef: alphaMsgResult.taskRef },
        { agent: liveAgent, callId: 'call-claim-a' } as any,
      )) as any
      expect(alphaClaims.kind).toBe('listed')
      expect(alphaClaims.taskRef).toBe(alphaMsgResult.taskRef)

      // 2. Now reactivate the global member in Workspace Beta
      await harness.ctx.agentTeam.reactivateMember(memberId, beta)

      const betaHandle = (host as any).handles.get(memberId)
      expect(betaHandle).toBeDefined()
      const betaLiveAgent = betaHandle.agent

      expect(betaLiveAgent.session.header.cwd).toBe(harness.workspacePaths[beta])
      expect(host.resolveWorkspaceIdForAgent(betaLiveAgent)).toBe(beta)

      // team_view in Beta targets Workspace Beta
      const betaView = (await teamView.execute({}, { agent: betaLiveAgent, callId: 'call-view-b' } as any)) as any
      expect(betaView.channels.some((c: any) => c.channelRef === betaChannel.channel.channelRef)).toBe(true)
      expect(betaView.channels.some((c: any) => c.channelRef === alphaChannel.channel.channelRef)).toBe(false)

      // team_message in Beta starts thread in Beta channel
      const betaMsgResult = (await teamMessage.execute(
        { action: 'start', channelRef: betaChannel.channel.channelRef, body: 'Hello Beta from global agent', asTask: true },
        { agent: betaLiveAgent, callId: 'call-msg-b' } as any,
      )) as any
      expect(betaMsgResult.kind).toBe('committed')
      expect(betaMsgResult.threadRef).toBeDefined()
      expect(betaMsgResult.taskRef).toBeDefined()

      // team_inbox in Beta reads Beta inbox
      const betaInbox = (await teamInbox.execute({}, { agent: betaLiveAgent, callId: 'call-inbox-b' } as any)) as any
      expect(betaInbox).toBeDefined()
      expect(betaInbox.totalUnreadCount).toBeGreaterThanOrEqual(0)

      // team_thread in Beta reads thread created in Beta
      const betaThreadRead = (await teamThread.execute(
        { action: 'read', threadRef: betaMsgResult.threadRef },
        { agent: betaLiveAgent, callId: 'call-thread-b' } as any,
      )) as any
      expect(betaThreadRead.threadRef).toBe(betaMsgResult.threadRef)

      // team_claim in Beta lists claims for task in Beta
      const betaClaims = (await teamClaim.execute(
        { action: 'list', taskRef: betaMsgResult.taskRef },
        { agent: betaLiveAgent, callId: 'call-claim-b' } as any,
      )) as any
      expect(betaClaims.kind).toBe('listed')
      expect(betaClaims.taskRef).toBe(betaMsgResult.taskRef)
    })
  })

  describe('Workspace-Scoped Agent Isolation Guarantees', () => {
    it('strictly isolates workspace-scoped agents to their own workspace', async () => {
      const harness = await createHarness()

      const betaChannel = await harness.ctx.agentTeam.createChannel({
        requestId: requestId('chan-beta-iso'),
        workspaceId: beta,
        name: 'beta-iso',
        description: 'Beta isolation channel',
      })

      // Add a workspace-scoped agent in Alpha
      const scopedAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('add-scoped-iso'),
        workspaceId: alpha,
        handle: 'local-specialist',
        description: 'Confined to Alpha',
        presetId: 'team-member',
        channelRefs: [],
      })

      expect(isGlobalMember(scopedAgent.status.member)).toBe(false)
      expect(scopedAgent.status.member.workspaceId).toBe(alpha)

      // Attempt to enroll scoped agent into Beta channel must be rejected by ledger
      await expect(
        harness.ctx.agentTeam.joinChannel({
          requestId: requestId('fail-scoped-join'),
          workspaceId: beta,
          channelRef: betaChannel.channel.channelRef,
          memberId: scopedAgent.status.member.memberId,
        }),
      ).rejects.toThrow('Member and Channel must belong to one Workspace')

      // Get real live agent for scoped agent
      const scopedHandle = (harness.ctx.agentTeam as any).handles.get(scopedAgent.status.member.memberId)
      expect(scopedHandle).toBeDefined()
      const scopedLiveAgent = scopedHandle.agent

      // Scoped agent resolving workspace always returns Alpha
      expect(harness.ctx.agentTeam.resolveWorkspaceIdForAgent(scopedLiveAgent)).toBe(alpha)

      // Attempting to mutate Beta via host method directly throws
      await expect(
        harness.ctx.agentTeam.sendMessageForAgent(scopedLiveAgent, {
          requestId: requestId('fail-scoped-msg'),
          workspaceId: beta,
          channelRef: betaChannel.channel.channelRef,
          body: 'Unauthorized cross-workspace message',
        }),
      ).rejects.toThrow('Member cannot mutate another Workspace')

      // Attempting to view Beta via host method directly throws
      expect(() =>
        harness.ctx.agentTeam.viewForAgent(scopedLiveAgent, {
          workspaceId: beta,
        }),
      ).toThrow('Member cannot view another Workspace')
    })
  })

  describe('Compaction Presence Emission for Global Agents', () => {
    it('wakes waiters across all workspaces for global agents, and only owning workspace for scoped agents', async () => {
      const harness = await createHarness()

      const globalAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('compaction-global'),
        workspaceId: alpha,
        handle: 'global-compact',
        description: 'Global compaction test',
        presetId: 'team-member',
        channelRefs: [],
        isGlobal: true,
      } as any)

      const scopedAgent = await harness.ctx.agentTeam.addMember({
        requestId: requestId('compaction-scoped'),
        workspaceId: alpha,
        handle: 'scoped-compact',
        description: 'Scoped compaction test',
        presetId: 'team-member',
        channelRefs: [],
      })

      // Test 1: Global agent compaction wakes a waiter listening on Workspace Beta
      const baseline1 = await harness.ctx.agentTeam.changes({ afterVersion: 0 })
      const betaWaiter1 = harness.ctx.agentTeam.changes({ afterVersion: baseline1.version, scope: { kind: 'workspace', workspaceId: beta } })
      let betaWoken1 = false
      void betaWaiter1.then(() => { betaWoken1 = true })

      ;(harness.ctx.agentTeam as any).emitAutoCompactionChanged(globalAgent.status.member.memberId)
      await new Promise(r => setTimeout(r, 20))
      expect(betaWoken1).toBe(true)

      // Test 2: Scoped agent compaction (in Alpha) does NOT wake a waiter listening on Workspace Beta
      const baseline2 = await harness.ctx.agentTeam.changes({ afterVersion: 0 })
      const betaWaiter2 = harness.ctx.agentTeam.changes({ afterVersion: baseline2.version, scope: { kind: 'workspace', workspaceId: beta } })
      let betaWoken2 = false
      void betaWaiter2.then(() => { betaWoken2 = true })

      ;(harness.ctx.agentTeam as any).emitAutoCompactionChanged(scopedAgent.status.member.memberId)
      await new Promise(r => setTimeout(r, 20))
      expect(betaWoken2).toBe(false)
    })
  })
})
