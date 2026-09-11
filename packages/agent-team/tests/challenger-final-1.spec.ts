import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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
const delta = WorkspaceId('workspace:delta')

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
  readonly attachedWorkspaces: Array<{ workspaceId: WorkspaceId; sessionId: SessionId }>
}

async function harness(): Promise<TestHarness> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-challenger-final-'))
  const workspacePaths: Record<WorkspaceId, string> = {
    [alpha]: join(tempRoot, 'workspace-alpha'),
    [beta]: join(tempRoot, 'workspace-beta'),
    [gamma]: join(tempRoot, 'workspace-gamma'),
    [delta]: join(tempRoot, 'workspace-delta'),
  }

  await Promise.all(
    Object.values(workspacePaths).map(p => mkdir(p, { recursive: true })),
  )

  await Promise.all([
    writeFile(join(workspacePaths[alpha]!, 'AGENTS.md'), '# Alpha AGENTS.md instructions'),
    writeFile(join(workspacePaths[beta]!, 'AGENTS.md'), '# Beta AGENTS.md instructions'),
    writeFile(join(workspacePaths[gamma]!, 'AGENTS.md'), '# Gamma AGENTS.md instructions'),
    writeFile(join(workspacePaths[delta]!, 'AGENTS.md'), '# Delta AGENTS.md instructions'),
  ])

  const createdSessions: Array<{ sessionId: SessionId; cwd?: string }> = []
  const attachedWorkspaces: Array<{ workspaceId: WorkspaceId; sessionId: SessionId }> = []
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

  return { ctx, facility, tempRoot, workspacePaths, createdSessions, attachedWorkspaces }
}

function replayLedger(facility: DomainFacility): AgentTeamLedger {
  return new AgentTeamLedger(facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
}

describe('Challenger Final 1: Tier 5 White-Box Boundary Hardening', () => {
  describe('Boundary 1: Rapid switching of global agent between workspaces', () => {
    it('handles sequential and rapid workspace switching without leaking handles or corrupting session cwd', async () => {
      const h = await harness()

      // 1. Add global agent in Alpha
      const added = await h.ctx.agentTeam.addMember({
        requestId: requestId('rapid-switch-agent'),
        workspaceId: alpha,
        handle: 'switch-agent',
        description: 'Agent switching workspaces rapidly',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })
      const member = added.status.member
      const memberId = member.memberId

      // Initial activation is in Alpha
      expect(h.ctx.agentTeam.resolveWorkspaceIdForAgent({ sessionId: member.sessionId })).toBe(alpha)

      // 2. Rapidly switch through Beta -> Gamma -> Delta -> Alpha -> Gamma -> Beta -> Delta
      const targets = [beta, gamma, delta, alpha, gamma, beta, delta]
      for (const target of targets) {
        const reactivated = await h.ctx.agentTeam.reactivateMember(memberId, target)
        expect(reactivated).toBe(true)

        // Verify active workspace resolved correctly
        const resolved = h.ctx.agentTeam.resolveWorkspaceIdForAgent({ sessionId: member.sessionId })
        expect(resolved).toBe(target)

        // Verify session header cwd matches target workspace path
        const lastSession = h.createdSessions.filter(s => s.sessionId === member.sessionId).at(-1)
        expect(lastSession).toBeDefined()
        expect(lastSession?.cwd).toBe(h.workspacePaths[target])
      }

      // Verify the private memory directory name remains constant
      const dirName = memberMemoryDirectoryName(memberId)
      expect(dirName).toBe(memberId.replaceAll(':', '-'))

      // Cold replay ledger check
      const cold = replayLedger(h.facility)
      expect(() => cold.validate()).not.toThrow()
    })

    it('survives concurrent reactivation attempts for global agent gracefully', async () => {
      const h = await harness()

      const added = await h.ctx.agentTeam.addMember({
        requestId: requestId('concurrent-switch-agent'),
        workspaceId: alpha,
        handle: 'concurrent-agent',
        description: 'Agent concurrent reactivation test',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })
      const memberId = added.status.member.memberId

      // Attempt concurrent reactivations to Beta and Gamma
      const results = await Promise.all([
        h.ctx.agentTeam.reactivateMember(memberId, beta),
        h.ctx.agentTeam.reactivateMember(memberId, gamma),
      ])
      expect(results.every(r => typeof r === 'boolean')).toBe(true)

      // Resolved workspace must be one of the valid targets (Beta or Gamma)
      const finalWs = h.ctx.agentTeam.resolveWorkspaceIdForAgent({ sessionId: added.status.member.sessionId })
      expect([beta, gamma]).toContain(finalWs)
    })
  })

  describe('Boundary 2: Archiving a global agent enrolled in channels across multiple workspaces', () => {
    it('releases all claims in foreign workspaces, clears attention, and emits global change scope', async () => {
      const h = await harness()
      const ledger = (h.ctx.agentTeam as unknown as { requireLedger: () => AgentTeamLedger }).requireLedger()

      // 1. Add global agent in Alpha
      const globalAgent = await h.ctx.agentTeam.addMember({
        requestId: requestId('multi-chan-global-arch'),
        workspaceId: alpha,
        handle: 'multi-arch-global',
        description: 'Global agent to be archived with multi-workspace claims',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })
      const gMemberId = globalAgent.status.member.memberId
      const gActor = { kind: 'member' as const, memberId: gMemberId, handle: 'multi-arch-global' }

      // 2. Create channels in Alpha, Beta, and Gamma
      await h.ctx.agentTeam.createChannel({
        requestId: requestId('chan-a'),
        workspaceId: alpha,
        name: 'chan-alpha',
        description: 'Channel in Alpha',
        memberIds: [gMemberId],
      })
      const chanBeta = await h.ctx.agentTeam.createChannel({
        requestId: requestId('chan-b'),
        workspaceId: beta,
        name: 'chan-beta',
        description: 'Channel in Beta',
        memberIds: [gMemberId],
      })
      const chanGamma = await h.ctx.agentTeam.createChannel({
        requestId: requestId('chan-g'),
        workspaceId: gamma,
        name: 'chan-gamma',
        description: 'Channel in Gamma',
        memberIds: [gMemberId],
      })

      // 3. Send messages to initiate tasks in Beta and Gamma
      const betaMsg = (await ledger.sendMessage({
        requestId: requestId('msg-beta-init'),
        workspaceId: beta,
        channelRef: chanBeta.channel.channelRef,
        body: 'Task message in Beta',
        actor: gActor,
      })).value
      expect(betaMsg.kind).toBe('committed')
      const betaTaskRef = betaMsg.kind === 'committed' ? betaMsg.task!.taskRef : null!

      const gammaMsg = (await ledger.sendMessage({
        requestId: requestId('msg-gamma-init'),
        workspaceId: gamma,
        channelRef: chanGamma.channel.channelRef,
        body: 'Task message in Gamma',
        actor: gActor,
      })).value
      expect(gammaMsg.kind).toBe('committed')
      const gammaTaskRef = gammaMsg.kind === 'committed' ? gammaMsg.task!.taskRef : null!

      // 4. Claim tasks in Beta and Gamma
      const claimBetaRes = (await ledger.changeClaim({
        requestId: requestId('claim-beta-act'),
        workspaceId: beta,
        taskRef: betaTaskRef,
        action: 'claim',
        direction: 'working',
        baseRevision: betaMsg.kind === 'committed' ? betaMsg.thread.revision : 1,
        actor: gActor,
      })).value
      expect(claimBetaRes.kind).toBe('committed')

      const claimGammaRes = (await ledger.changeClaim({
        requestId: requestId('claim-gamma-act'),
        workspaceId: gamma,
        taskRef: gammaTaskRef,
        action: 'claim',
        direction: 'investigating',
        baseRevision: gammaMsg.kind === 'committed' ? gammaMsg.thread.revision : 1,
        actor: gActor,
      })).value
      expect(claimGammaRes.kind).toBe('committed')

      // Verify claims are active
      expect(ledger.activeClaimsForMember(gMemberId).length).toBe(2)

      // 5. Setup foreign workspace change waiter
      const baselineVersion = (await h.ctx.agentTeam.changes({ afterVersion: 0 })).version
      const waiterBeta = h.ctx.agentTeam.changes({ afterVersion: baselineVersion, scope: { kind: 'workspace', workspaceId: beta } })

      // 6. Archive the global agent
      const archResult = await h.ctx.agentTeam.archiveMember({
        requestId: requestId('archive-multi-g'),
        memberId: gMemberId,
      })

      expect(archResult.member.state).toBe('archived')
      // For global members, changeScopesOf must return undefined (global broadcast)
      const archOp = ledger.getOperation(archResult.receipt.operationId)!
      expect(ledger.changeScopesOf(archOp)).toBeUndefined()

      // Foreign workspace watcher is notified
      expect(await waiterBeta).toMatchObject({ version: expect.any(Number) })

      // 7. Verify all claims across workspaces are released
      expect(ledger.activeClaimsForMember(gMemberId).length).toBe(0)

      // 8. Verify membersForClient in all workspaces shows archived
      for (const ws of [alpha, beta, gamma]) {
        const clientMembers = h.ctx.agentTeam.membersForClient({ workspaceId: ws })
        const found = clientMembers.find(m => m.member.memberId === gMemberId)
        expect(found).toBeDefined()
        expect(found!.member.state).toBe('archived')
      }

      // 9. Mentioning archived global agent in foreign workspace channels is rejected
      await expect(h.ctx.agentTeam.sendMessage({
        requestId: requestId('mention-after-archive-beta'),
        workspaceId: beta,
        channelRef: chanBeta.channel.channelRef,
        body: 'Mentioning archived agent in Beta',
        recipients: [gMemberId],
      })).rejects.toThrow(/is not authorized for Channel/)

      // 10. Cold replay validation succeeds
      const cold = replayLedger(h.facility)
      expect(() => cold.validate()).not.toThrow()
    })
  })

  describe('Boundary 3: Demotion guard enforcement', () => {
    it('strictly forbids setting isGlobal: false while enrolled in foreign channels, and succeeds once removed', async () => {
      const h = await harness()

      // Global agent with home workspace Alpha
      const added = await h.ctx.agentTeam.addMember({
        requestId: requestId('demote-guard-agent'),
        workspaceId: alpha,
        handle: 'demote-guard',
        description: 'Agent for demotion guard test',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })
      const memberId = added.status.member.memberId

      // Create channel in Beta (foreign) and enroll the global agent
      const betaChan = await h.ctx.agentTeam.createChannel({
        requestId: requestId('beta-chan-guard'),
        workspaceId: beta,
        name: 'guard-beta',
        description: 'Foreign beta channel',
        memberIds: [memberId],
      })

      // Also create local channel in Alpha (home) and enroll
      await h.ctx.agentTeam.createChannel({
        requestId: requestId('alpha-chan-guard'),
        workspaceId: alpha,
        name: 'guard-alpha',
        description: 'Home alpha channel',
        memberIds: [memberId],
      })

      // Attempt demotion to isGlobal: false -> MUST FAIL
      await expect(h.ctx.agentTeam.updateMember({
        requestId: requestId('attempt-demote-fail'),
        memberId,
        handle: 'demote-guard',
        description: 'Attempted demote',
        isGlobal: false,
      })).rejects.toThrow(/Cannot demote Agent Member '.*' to workspace-scoped while enrolled in foreign channels/)

      // Verify agent remains global
      const membersBeta = h.ctx.agentTeam.membersForClient({ workspaceId: beta })
      const gMember = membersBeta.find(m => m.member.memberId === memberId)
      expect(isGlobalMember(gMember?.member)).toBe(true)

      // Remove from foreign channel in Beta
      await h.ctx.agentTeam.removeChannelMember({
        requestId: requestId('remove-from-foreign-beta'),
        workspaceId: beta,
        channelRef: betaChan.channel.channelRef,
        memberId,
      })

      // Now demotion to workspace-scoped MUST SUCCEED (only enrolled in Alpha, home workspace)
      const demoted = await h.ctx.agentTeam.updateMember({
        requestId: requestId('demote-now-succeeds'),
        memberId,
        handle: 'demote-guard',
        description: 'Now local to Alpha',
        isGlobal: false,
      })
      expect(isGlobalMember(demoted.status.member)).toBe(false)
      expect(demoted.status.member.workspaceId).toBe(alpha)

      // Post-demotion: agent can no longer be seen in Beta client list
      const membersBetaAfter = h.ctx.agentTeam.membersForClient({ workspaceId: beta })
      expect(membersBetaAfter.some(m => m.member.memberId === memberId)).toBe(false)

      // Post-demotion: agent cannot join Beta channels anymore
      await expect(h.ctx.agentTeam.joinChannel({
        requestId: requestId('join-beta-after-demote'),
        workspaceId: beta,
        channelRef: betaChan.channel.channelRef,
        memberId,
      })).rejects.toThrow(/Member and Channel must belong to one Workspace/)
    })
  })

  describe('Boundary 4: Local agent isolation across workspaces', () => {
    it('prevents local agents from joining foreign channels, being mentioned in foreign channels, or viewing foreign workspaces', async () => {
      const h = await harness()

      // Local agent in Alpha
      const localAlpha = await h.ctx.agentTeam.addMember({
        requestId: requestId('isolated-local-alpha'),
        workspaceId: alpha,
        handle: 'local-alpha',
        description: 'Strictly local to Alpha',
        presetId: 'general',
        channelRefs: [],
      })
      const lAlphaId = localAlpha.status.member.memberId
      expect(isGlobalMember(localAlpha.status.member)).toBe(false)

      // Channel in Beta
      const chanBeta = await h.ctx.agentTeam.createChannel({
        requestId: requestId('chan-beta-iso'),
        workspaceId: beta,
        name: 'beta-iso',
        description: 'Beta isolation channel',
      })

      // 1. Cannot join foreign channel
      await expect(h.ctx.agentTeam.joinChannel({
        requestId: requestId('local-join-foreign-fail'),
        workspaceId: beta,
        channelRef: chanBeta.channel.channelRef,
        memberId: lAlphaId,
      })).rejects.toThrow(/Member and Channel must belong to one Workspace/)

      // 2. Cannot create foreign channel with local agent as initial member
      await expect(h.ctx.agentTeam.createChannel({
        requestId: requestId('foreign-chan-with-local-init-fail'),
        workspaceId: beta,
        name: 'beta-invalid-member',
        description: 'Should reject local member from alpha',
        memberIds: [lAlphaId],
      })).rejects.toThrow(/does not belong to Workspace|invalid initial Channel Member/)

      // 3. Local agent cannot be mentioned in foreign channel
      await expect(h.ctx.agentTeam.sendMessage({
        requestId: requestId('mention-foreign-local-fail'),
        workspaceId: beta,
        channelRef: chanBeta.channel.channelRef,
        body: 'Calling @local-alpha in Beta',
        recipients: [lAlphaId],
      })).rejects.toThrow(/is not authorized for Channel|invalid Message mention target/)

      // 4. Local agent cannot view foreign workspace
      const localLiveAgent = (h.ctx.agentTeam as any).handles.get(lAlphaId)?.agent
      expect(localLiveAgent).toBeDefined()
      expect(() => h.ctx.agentTeam.viewForAgent(localLiveAgent, {
        workspaceId: beta,
      })).toThrow('Member cannot view another Workspace')

      // 5. Local agent can be promoted to global and then joins foreign channel seamlessly
      const promoted = await h.ctx.agentTeam.updateMember({
        requestId: requestId('promote-local-to-global'),
        memberId: lAlphaId,
        handle: 'local-alpha',
        description: 'Promoted to global',
        isGlobal: true,
      })
      expect(isGlobalMember(promoted.status.member)).toBe(true)

      // Now joinChannel in Beta succeeds!
      const joinPromoted = await h.ctx.agentTeam.joinChannel({
        requestId: requestId('promoted-join-beta-success'),
        workspaceId: beta,
        channelRef: chanBeta.channel.channelRef,
        memberId: lAlphaId,
      })
      expect(joinPromoted.memberId).toBe(lAlphaId)

      // Cold replay validation
      const cold = replayLedger(h.facility)
      expect(() => cold.validate()).not.toThrow()
    })
  })
})
