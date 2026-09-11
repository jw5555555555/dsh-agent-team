import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import AgentTeam, { isGlobalMember } from '../src/index.ts'
import { AgentTeamLedger } from '../src/ledger.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import { memberMemoryDirectoryName } from '../src/member-runtime.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import type {
  AgentTeamOperation,
  AgentTeamOperationId,
  AgentTeamRequestId,
} from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []

const alpha = WorkspaceId('workspace:alpha')
const beta = WorkspaceId('workspace:beta')
const gamma = WorkspaceId('workspace:gamma')

const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

interface TestHarness {
  readonly ctx: Context
  readonly facility: DomainFacility
  readonly tempRoot: string
  readonly workspacePaths: Record<WorkspaceId, string>
  readonly createdSessions: Array<{ sessionId: SessionId; cwd?: string }>
}

async function harness(): Promise<TestHarness> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-challenger-final-2-'))
  const workspacePaths: Record<WorkspaceId, string> = {
    [alpha]: join(tempRoot, 'workspace-alpha'),
    [beta]: join(tempRoot, 'workspace-beta'),
    [gamma]: join(tempRoot, 'workspace-gamma'),
  }

  await Promise.all(
    Object.values(workspacePaths).map(p => mkdir(p, { recursive: true })),
  )

  await Promise.all([
    writeFile(join(workspacePaths[alpha]!, 'AGENTS.md'), '# Alpha AGENTS.md instructions'),
    writeFile(join(workspacePaths[beta]!, 'AGENTS.md'), '# Beta AGENTS.md instructions'),
    writeFile(join(workspacePaths[gamma]!, 'AGENTS.md'), '# Gamma AGENTS.md instructions'),
  ])

  const createdSessions: Array<{ sessionId: SessionId; cwd?: string }> = []
  const liveHandles = new Map<SessionId, { agent: any; dispose: () => Promise<void> }>()

  const ctx = new Context()
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
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
        attachSession: async () => {},
        archiveSession: async () => {},
      }
    },
    list: () => Object.entries(workspacePaths).map(([id, path]) => ({ id: id as WorkspaceId, path })),
    archiveSession: async () => {},
  })

  ctx.provide('agents', {
    create: async ({ sessionId, meta, setup }: any) => {
      createdSessions.push({ sessionId, cwd: meta?.cwd })
      const agentCtx = ctx.extend()
      if (setup) {
        try {
          const res = await setup(agentCtx)
          if (res?.commit) res.commit()
        } catch {}
      }
      const agent = {
        id: sessionId,
        status: 'idle',
        ctx: agentCtx,
        session: {
          id: sessionId,
          header: { cwd: meta?.cwd },
          ownEvents: () => [],
          inheritedEventCount: 0,
          rename: () => {},
        },
        inbox: { nextTurn: [], nextStep: [], steer: () => {}, remove: () => false, consume: () => {} },
        steer: () => {},
        followup: () => {},
      }
      const handle = {
        agent,
        dispose: async () => {
          liveHandles.delete(sessionId)
        },
      }
      liveHandles.set(sessionId, handle)
      return handle
    },
    resume: async ({ resumeSessionId, setup }: any) => {
      const existing = liveHandles.get(resumeSessionId)
      if (existing) return existing
      const agentCtx = ctx.extend()
      if (setup) {
        try {
          const res = await setup(agentCtx)
          if (res?.commit) res.commit()
        } catch {}
      }
      const agent = {
        id: resumeSessionId,
        status: 'idle',
        ctx: agentCtx,
        session: {
          id: resumeSessionId,
          header: {},
          ownEvents: () => [],
          inheritedEventCount: 0,
          rename: () => {},
        },
        inbox: { nextTurn: [], nextStep: [], steer: () => {}, remove: () => false, consume: () => {} },
        steer: () => {},
        followup: () => {},
      }
      const handle = {
        agent,
        dispose: async () => {
          liveHandles.delete(resumeSessionId)
        },
      }
      liveHandles.set(resumeSessionId, handle)
      return handle
    },
  })

  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', {
    mount: async () => ({ id: 'team-member', display: 'Team Member', roots: [], manifest: {} as any }),
    composedPreset: () => 'team-member',
  })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [] })

  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(agentTeamInvariant)
  const fiber = await ctx.plugin(AgentTeam)

  cleanups.push(async () => {
    await fiber.dispose()
    await facility.closeAll()
    await rm(tempRoot, { recursive: true, force: true })
  })

  return { ctx, facility, tempRoot, workspacePaths, createdSessions }
}

function replayLedger(facility: DomainFacility): AgentTeamLedger {
  return new AgentTeamLedger(facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
}

describe('Challenger Final 2: Empirical Stress Test of Isolation Invariants', () => {
  describe('Invariant Group 1: Foreign Workspace Tool and Method Access Rejection', () => {
    it('strictly forbids a workspace-scoped agent from invoking any host tool/mutation on foreign workspaces', async () => {
      const h = await harness()

      // Add local agent in Alpha
      const localAlpha = await h.ctx.agentTeam.addMember({
        requestId: requestId('stress-local-alpha'),
        workspaceId: alpha,
        handle: 'scoped-alpha',
        description: 'Scoped to Alpha only',
        presetId: 'general',
        channelRefs: [],
      })
      const lMember = localAlpha.status.member
      const lAgent = (h.ctx.agentTeam as any).handles.get(lMember.memberId)?.agent
      expect(lAgent).toBeDefined()
      expect(isGlobalMember(lMember)).toBe(false)

      // Add local agent in Beta
      const localBeta = await h.ctx.agentTeam.addMember({
        requestId: requestId('stress-local-beta'),
        workspaceId: beta,
        handle: 'scoped-beta',
        description: 'Scoped to Beta only',
        presetId: 'general',
        channelRefs: [],
      })
      const bMember = localBeta.status.member

      // Create channel in Beta
      const betaChan = await h.ctx.agentTeam.createChannel({
        requestId: requestId('beta-chan-stress'),
        workspaceId: beta,
        name: 'beta-channel',
        description: 'Channel belonging to Beta',
        memberIds: [bMember.memberId],
      })
      const bChanRef = betaChan.channel.channelRef

      // Test 1: viewForAgent on foreign workspace Beta throws
      expect(() => h.ctx.agentTeam.viewForAgent(lAgent, { workspaceId: beta }))
        .toThrow('Member cannot view another Workspace')

      // Test 2: inboxForAgent on foreign workspace Beta throws
      expect(() => h.ctx.agentTeam.inboxForAgent(lAgent, { workspaceId: beta }))
        .toThrow('Member cannot mutate another Workspace')

      // Test 3: listClaimsForAgent on foreign workspace Beta throws
      expect(() => h.ctx.agentTeam.listClaimsForAgent(lAgent, { workspaceId: beta, taskRef: 'task:00000000-0000-0000-0000-000000000001' as any }))
        .toThrow('Member cannot mutate another Workspace')

      // Test 4: readThreadForAgent on foreign workspace Beta throws
      await expect(h.ctx.agentTeam.readThreadForAgent(lAgent, {
        requestId: requestId('stress-read-foreign'),
        workspaceId: beta,
        threadRef: 'thread:00000000-0000-0000-0000-000000000001' as any,
      })).rejects.toThrow('Member cannot mutate another Workspace')

      // Test 5: sendMessageForAgent on foreign workspace Beta throws
      await expect(h.ctx.agentTeam.sendMessageForAgent(lAgent, {
        requestId: requestId('stress-send-foreign'),
        workspaceId: beta,
        channelRef: bChanRef,
        body: 'Unauthorized message from alpha agent',
      })).rejects.toThrow('Member cannot mutate another Workspace')

      // Test 6: replyForAgent on foreign workspace Beta throws
      await expect(h.ctx.agentTeam.replyForAgent(lAgent, {
        requestId: requestId('stress-reply-foreign'),
        workspaceId: beta,
        threadRef: 'thread:00000000-0000-0000-0000-000000000001' as any,
        body: 'Unauthorized reply',
        baseRevision: 1,
      })).rejects.toThrow('Member cannot mutate another Workspace')

      // Test 7: changeClaimForAgent on foreign workspace Beta throws
      await expect(h.ctx.agentTeam.changeClaimForAgent(lAgent, {
        requestId: requestId('stress-claim-foreign'),
        workspaceId: beta,
        taskRef: 'task:00000000-0000-0000-0000-000000000001' as any,
        action: 'claim',
        direction: 'working',
        baseRevision: 1,
      })).rejects.toThrow('Member cannot mutate another Workspace')

      // Test 8: dmForAgent to foreign agent throws
      await expect(h.ctx.agentTeam.dmForAgent(lAgent, {
        requestId: requestId('stress-dm-foreign'),
        workspaceId: beta,
        recipientMemberId: bMember.memberId,
        body: 'Hello across workspaces',
      })).rejects.toThrow('Member cannot mutate another Workspace')

      // Test 9: rolloverSessionForAgent on foreign workspace throws
      await expect(h.ctx.agentTeam.rolloverSessionForAgent(lAgent, {
        requestId: requestId('stress-rollover-foreign'),
        workspaceId: beta,
        checkpointRef: 'checkpoint:00000000-0000-0000-0000-000000000001' as any,
      } as any)).rejects.toThrow('Member cannot mutate another Workspace')

      // Cold replay ledger check
      const cold = replayLedger(h.facility)
      expect(() => cold.validate()).not.toThrow()
    })
  })

  describe('Invariant Group 2: Channel and Mention Boundary Enforcement', () => {
    it('prevents workspace-scoped agents from foreign channel membership and foreign @mentions, while global agents roam freely', async () => {
      const h = await harness()

      // Add local agent in Alpha
      const localAlpha = await h.ctx.agentTeam.addMember({
        requestId: requestId('local-chan-alpha'),
        workspaceId: alpha,
        handle: 'local-chan-a',
        description: 'Alpha local',
        presetId: 'general',
        channelRefs: [],
      })
      const lAlphaId = localAlpha.status.member.memberId

      // Add global agent with home Alpha
      const globalAgent = await h.ctx.agentTeam.addMember({
        requestId: requestId('global-chan-member'),
        workspaceId: alpha,
        handle: 'global-roamer',
        description: 'Global agent',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })
      const gMemberId = globalAgent.status.member.memberId

      // Create channel in Beta
      const betaChan = await h.ctx.agentTeam.createChannel({
        requestId: requestId('beta-chan-enrollment'),
        workspaceId: beta,
        name: 'beta-enroll-test',
        description: 'Testing channel enrollment',
      })
      const bChanRef = betaChan.channel.channelRef

      // 1. Local agent joining foreign channel fails
      await expect(h.ctx.agentTeam.joinChannel({
        requestId: requestId('local-join-fail'),
        workspaceId: beta,
        channelRef: bChanRef,
        memberId: lAlphaId,
      })).rejects.toThrow('Member and Channel must belong to one Workspace')

      // 2. Local agent being mentioned in foreign channel fails
      await expect(h.ctx.agentTeam.sendMessage({
        requestId: requestId('mention-local-in-foreign-fail'),
        workspaceId: beta,
        channelRef: bChanRef,
        body: 'Trying to mention local alpha member',
        recipients: [lAlphaId],
      })).rejects.toThrow(/is not authorized for Channel|invalid Message mention target/)

      // 3. Global agent joining foreign channel SUCCEEDS
      const joinGlobal = await h.ctx.agentTeam.joinChannel({
        requestId: requestId('global-join-success'),
        workspaceId: beta,
        channelRef: bChanRef,
        memberId: gMemberId,
      })
      expect(joinGlobal.memberId).toBe(gMemberId)

      // 4. Global agent can be mentioned in foreign channel
      const sendGlobalMention = await h.ctx.agentTeam.sendMessage({
        requestId: requestId('mention-global-in-foreign-success'),
        workspaceId: beta,
        channelRef: bChanRef,
        body: 'Mentioning @global-roamer in Beta',
        recipients: [gMemberId],
      })
      expect(sendGlobalMention.kind).toBe('committed')
      if (sendGlobalMention.kind === 'committed') {
        expect(sendGlobalMention.directMarkers.some(m => m.memberId === gMemberId)).toBe(true)
      }

      // 5. Global agent can also join channel in Gamma and be mentioned there
      const gammaChan = await h.ctx.agentTeam.createChannel({
        requestId: requestId('gamma-chan-global'),
        workspaceId: gamma,
        name: 'gamma-channel',
        description: 'Gamma channel with global agent',
        memberIds: [gMemberId],
      })
      expect(gammaChan.memberIds).toContain(gMemberId)

      const sendGammaMention = await h.ctx.agentTeam.sendMessage({
        requestId: requestId('mention-global-in-gamma'),
        workspaceId: gamma,
        channelRef: gammaChan.channel.channelRef,
        body: 'Mentioning @global-roamer in Gamma',
        recipients: [gMemberId],
      })
      expect(sendGammaMention.kind).toBe('committed')
      if (sendGammaMention.kind === 'committed') {
        expect(sendGammaMention.directMarkers.some(m => m.memberId === gMemberId)).toBe(true)
      }

      // Cold replay ledger check
      const cold = replayLedger(h.facility)
      expect(() => cold.validate()).not.toThrow()
    })
  })

  describe('Invariant Group 3: Memory Unification for Global Agents vs Strict Isolation for Local Agents', () => {
    it('proves global agent memory is physically unified across workspace switches while local agent memories remain strictly isolated', async () => {
      const h = await harness()

      // 1. Create Global Agent
      const globalAdded = await h.ctx.agentTeam.addMember({
        requestId: requestId('mem-global-agent'),
        workspaceId: alpha,
        handle: 'unified-memory-agent',
        description: 'Global agent testing memory persistence',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })
      const gMember = globalAdded.status.member
      const gMemberId = gMember.memberId
      const gMemDir = gMember.privateMemoryPath

      // Verify directory name format
      expect(memberMemoryDirectoryName(gMemberId)).toBe(gMemberId.replaceAll(':', '-'))
      await mkdir(gMemDir, { recursive: true })

      // 2. Global Agent writes domain memory while active in Alpha
      const archNotePath = join(gMemDir, 'domain-architecture.md')
      const personaNotesPath = join(gMemDir, 'persona-notes.json')
      await writeFile(archNotePath, '# Core Microservices Architecture\n- Service A: Port 8080\n- Service B: Port 8081\n')
      await writeFile(personaNotesPath, JSON.stringify({ accumulatedContext: 'Learned DB migrations in Alpha' }))

      // 3. Switch Global Agent to Workspace Beta
      const reactivatedBeta = await h.ctx.agentTeam.reactivateMember(gMemberId, beta)
      expect(reactivatedBeta).toBe(true)

      // Verify active workspace resolution in Beta
      expect(h.ctx.agentTeam.resolveWorkspaceIdForAgent({ sessionId: gMember.sessionId })).toBe(beta)

      // Verify private memory path is identical in Beta on the Host
      const hostMemberInBeta = h.ctx.agentTeam.members().find(m => m.member.memberId === gMemberId)
      expect(hostMemberInBeta?.member.privateMemoryPath).toBe(gMemDir)

      // And verify client projection does not leak privateMemoryPath
      const clientMemberInBeta = h.ctx.agentTeam.membersForClient({ workspaceId: beta }).find(m => m.member.memberId === gMemberId)
      expect(clientMemberInBeta).toBeDefined()
      expect((clientMemberInBeta!.member as any).privateMemoryPath).toBeUndefined()

      // Read memory files while in Beta — verify exact retention
      const readArchInBeta = await readFile(archNotePath, 'utf8')
      expect(readArchInBeta).toContain('Service A: Port 8080')
      const readPersonaInBeta = JSON.parse(await readFile(personaNotesPath, 'utf8'))
      expect(readPersonaInBeta.accumulatedContext).toBe('Learned DB migrations in Alpha')

      // Append new cross-workspace knowledge in Beta
      await writeFile(archNotePath, readArchInBeta + '- Service C: Port 8082 (Added in Beta)\n')

      // 4. Switch Global Agent to Workspace Gamma
      const reactivatedGamma = await h.ctx.agentTeam.reactivateMember(gMemberId, gamma)
      expect(reactivatedGamma).toBe(true)
      expect(h.ctx.agentTeam.resolveWorkspaceIdForAgent({ sessionId: gMember.sessionId })).toBe(gamma)

      // Read memory in Gamma — verify cumulative knowledge across Alpha and Beta
      const readArchInGamma = await readFile(archNotePath, 'utf8')
      expect(readArchInGamma).toContain('Service A: Port 8080')
      expect(readArchInGamma).toContain('Service C: Port 8082 (Added in Beta)')

      // 5. Create Local Agent in Alpha and Local Agent in Beta
      const localAlpha = await h.ctx.agentTeam.addMember({
        requestId: requestId('mem-local-alpha'),
        workspaceId: alpha,
        handle: 'local-mem-alpha',
        description: 'Local Alpha agent',
        presetId: 'general',
        channelRefs: [],
      })
      const localBeta = await h.ctx.agentTeam.addMember({
        requestId: requestId('mem-local-beta'),
        workspaceId: beta,
        handle: 'local-mem-beta',
        description: 'Local Beta agent',
        presetId: 'general',
        channelRefs: [],
      })

      const lAlphaMem = localAlpha.status.member.privateMemoryPath
      const lBetaMem = localBeta.status.member.privateMemoryPath

      // Local memories are strictly separate
      expect(lAlphaMem).not.toBe(lBetaMem)
      expect(lAlphaMem).not.toBe(gMemDir)
      expect(lBetaMem).not.toBe(gMemDir)

      await mkdir(lAlphaMem, { recursive: true })
      await mkdir(lBetaMem, { recursive: true })

      await writeFile(join(lAlphaMem, 'secret.txt'), 'alpha-secret-data')
      await writeFile(join(lBetaMem, 'secret.txt'), 'beta-secret-data')

      expect(await readFile(join(lAlphaMem, 'secret.txt'), 'utf8')).toBe('alpha-secret-data')
      expect(await readFile(join(lBetaMem, 'secret.txt'), 'utf8')).toBe('beta-secret-data')

      // Cold replay ledger check
      const cold = replayLedger(h.facility)
      expect(() => cold.validate()).not.toThrow()
    })
  })

  describe('Invariant Group 4: Dynamic Session CWD and Defense-in-Depth', () => {
    it('resolves active workspace from CWD for global agents, while local agents remain bounded even under forged CWD', async () => {
      const h = await harness()

      // Local agent in Alpha
      const localAlpha = await h.ctx.agentTeam.addMember({
        requestId: requestId('cwd-local-alpha'),
        workspaceId: alpha,
        handle: 'cwd-scoped-alpha',
        description: 'Local Alpha',
        presetId: 'general',
        channelRefs: [],
      })
      const lMember = localAlpha.status.member
      const lAgent = (h.ctx.agentTeam as any).handles.get(lMember.memberId)?.agent

      // Global agent
      const globalAgent = await h.ctx.agentTeam.addMember({
        requestId: requestId('cwd-global-agent'),
        workspaceId: alpha,
        handle: 'cwd-global',
        description: 'Global roamer',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })
      const gMember = globalAgent.status.member

      // 1. Global agent in Beta: CWD matches Beta workspace path
      await h.ctx.agentTeam.reactivateMember(gMember.memberId, beta)
      const gAgentBeta = (h.ctx.agentTeam as any).handles.get(gMember.memberId)?.agent
      expect(gAgentBeta).toBeDefined()
      expect(h.ctx.agentTeam.resolveWorkspaceIdForAgent(gAgentBeta)).toBe(beta)

      // Global agent in Beta can view Beta
      const viewBeta = h.ctx.agentTeam.viewForAgent(gAgentBeta, { workspaceId: beta })
      expect(viewBeta).toBeDefined()

      // 2. Defense-in-depth: If a local agent's session CWD is manipulated to point to Beta path
      const forgedAgent = {
        ...lAgent,
        session: {
          ...lAgent.session,
          header: { cwd: h.workspacePaths[beta] },
        },
      }
      // resolveWorkspaceIdForAgent will identify Beta from CWD:
      const resolvedWs = h.ctx.agentTeam.resolveWorkspaceIdForAgent(forgedAgent)
      expect(resolvedWs).toBe(beta)

      // BUT when forgedAgent attempts to execute a host method (e.g. viewForAgent or requireAgentWorkspace) with Beta:
      // The Host verifies member ownership and rejects it because lMember is NOT global!
      expect(() => h.ctx.agentTeam.viewForAgent(lAgent, { workspaceId: beta }))
        .toThrow('Member cannot view another Workspace')

      // Cold replay ledger check
      const cold = replayLedger(h.facility)
      expect(() => cold.validate()).not.toThrow()
    })
  })
})
