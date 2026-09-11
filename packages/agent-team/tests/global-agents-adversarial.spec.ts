import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import AgentTeam from '../src/index.ts'
import { AgentTeamLedger } from '../src/ledger.ts'
import { isGlobalMember } from '../src/types/entities.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
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
const allWorkspaces = [alpha, beta, gamma, delta]

const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

interface TestHarness {
  readonly ctx: Context
  readonly facility: DomainFacility
}

async function staysPending(promise: Promise<unknown>, ms = 25): Promise<boolean> {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setTimeout(resolve, ms))
  return !settled
}

async function harness(pool = new MemoryMediaPool()): Promise<TestHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => allWorkspaces.includes(id) ? { id, path: process.cwd(), attachSession: async () => {}, archiveSession: async () => {} } : undefined,
    list: () => allWorkspaces.map(id => ({ id, path: process.cwd() })),
    archiveSession: async () => {},
  })
  const mockHandle = (sessionId: any) => {
    const agentCtx = new Context()
    return {
      agent: {
        id: sessionId,
        status: 'idle',
        ctx: agentCtx,
        session: { ownEvents: () => [] },
      },
      dispose: async () => {},
    }
  }
  ctx.provide('agents', {
    create: async ({ sessionId, setup }: any) => {
      const handle = mockHandle(sessionId)
      if (setup) {
        try {
          const res = await setup(handle.agent.ctx)
          if (res?.commit) res.commit()
        } catch {}
      }
      return handle
    },
    resume: async ({ resumeSessionId, setup }: any) => {
      const handle = mockHandle(resumeSessionId)
      if (setup) {
        try {
          const res = await setup(handle.agent.ctx)
          if (res?.commit) res.commit()
        } catch {}
      }
      return handle
    },
  })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', {
    mount: async () => ({}),
    composedPreset: () => 'team-member',
  })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [] })
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(agentTeamInvariant)
  const fiber = await ctx.plugin(AgentTeam)
  cleanups.push(async () => { await fiber.dispose(); await facility.closeAll() })
  return { ctx, facility }
}

function replayLedger(facility: DomainFacility): AgentTeamLedger {
  return new AgentTeamLedger(facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
}

describe('Adversarial Challenge: Milestone 1 Boundary & Corner Cases', () => {
  describe('1. Multi-workspace cross-enrollment across 3+ distinct workspaces', () => {
    it('supports a global agent simultaneously active across 4 distinct workspaces', async () => {
      const { ctx, facility } = await harness()

      // Provision global agent in Alpha
      const globalAgent = await ctx.agentTeam.addMember({
        requestId: requestId('multi-agent-global'),
        workspaceId: alpha,
        handle: 'global-coordinator',
        description: 'Multi-workspace coordinator',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })
      const memberId = globalAgent.status.member.memberId

      // Create channels in all 4 workspaces: Alpha, Beta, Gamma, Delta
      await ctx.agentTeam.createChannel({
        requestId: requestId('chan-alpha'),
        workspaceId: alpha,
        name: 'alpha-ops',
        description: 'Alpha operations',
        memberIds: [memberId],
      })
      const chanBeta = await ctx.agentTeam.createChannel({
        requestId: requestId('chan-beta'),
        workspaceId: beta,
        name: 'beta-ops',
        description: 'Beta operations',
        memberIds: [memberId],
      })
      const chanGamma = await ctx.agentTeam.createChannel({
        requestId: requestId('chan-gamma'),
        workspaceId: gamma,
        name: 'gamma-ops',
        description: 'Gamma operations',
        memberIds: [memberId],
      })
      const chanDelta = await ctx.agentTeam.createChannel({
        requestId: requestId('chan-delta'),
        workspaceId: delta,
        name: 'delta-ops',
        description: 'Delta operations',
      })
      // Join delta explicitly
      await ctx.agentTeam.joinChannel({
        requestId: requestId('join-delta'),
        workspaceId: delta,
        channelRef: chanDelta.channel.channelRef,
        memberId,
      })

      // Verify membersForClient in all 4 workspaces sees the global agent
      for (const ws of [alpha, beta, gamma, delta]) {
        const clientMembers = ctx.agentTeam.membersForClient({ workspaceId: ws })
        expect(clientMembers.some(m => m.member.memberId === memberId && isGlobalMember(m.member))).toBe(true)
      }

      // Verify global agent can act in Beta: start task and reply
      const ledger = (ctx.agentTeam as unknown as { requireLedger: () => AgentTeamLedger }).requireLedger()
      const memberActor = { kind: 'member' as const, memberId, handle: 'global-coordinator' }

      const betaMsg = (await ledger.sendMessage({
        requestId: requestId('beta-act-msg'),
        workspaceId: beta,
        channelRef: chanBeta.channel.channelRef,
        body: 'Message from global agent in Beta',
        actor: memberActor,
      })).value
      expect(betaMsg.kind).toBe('committed')
      if (betaMsg.kind !== 'committed') throw new Error('expected committed')

      // Global agent claims the task in Beta
      const claimRes = (await ledger.changeClaim({
        requestId: requestId('beta-claim'),
        workspaceId: beta,
        taskRef: betaMsg.task!.taskRef,
        action: 'claim',
        direction: 'investigating',
        baseRevision: betaMsg.thread.revision,
        actor: memberActor,
      })).value
      expect(claimRes.kind).toBe('committed')

      // Global agent acts in Gamma
      const gammaMsg = (await ledger.sendMessage({
        requestId: requestId('gamma-act-msg'),
        workspaceId: gamma,
        channelRef: chanGamma.channel.channelRef,
        body: 'Message from global agent in Gamma',
        actor: memberActor,
      })).value
      expect(gammaMsg.kind).toBe('committed')

      // Global agent acts in Delta
      const deltaMsg = (await ledger.sendMessage({
        requestId: requestId('delta-act-msg'),
        workspaceId: delta,
        channelRef: chanDelta.channel.channelRef,
        body: 'Message from global agent in Delta',
        actor: memberActor,
      })).value
      expect(deltaMsg.kind).toBe('committed')

      // Demotion guard: cannot demote while enrolled in foreign channels (Beta, Gamma, Delta)
      await expect(ctx.agentTeam.updateMember({
        requestId: requestId('demote-fail-multi'),
        memberId,
        handle: 'global-coordinator',
        description: 'Attempted local',
        isGlobal: false,
      })).rejects.toThrow(/Cannot demote Agent Member '.*' to workspace-scoped while enrolled in foreign channels/)

      // Remove from Gamma and Delta
      await ctx.agentTeam.removeChannelMember({
        requestId: requestId('remove-gamma'),
        workspaceId: gamma,
        channelRef: chanGamma.channel.channelRef,
        memberId,
      })
      await ctx.agentTeam.removeChannelMember({
        requestId: requestId('remove-delta'),
        workspaceId: delta,
        channelRef: chanDelta.channel.channelRef,
        memberId,
      })

      // Still in Beta -> demotion still rejected
      await expect(ctx.agentTeam.updateMember({
        requestId: requestId('demote-fail-still-beta'),
        memberId,
        handle: 'global-coordinator',
        description: 'Attempted local',
        isGlobal: false,
      })).rejects.toThrow(/Cannot demote Agent Member '.*' to workspace-scoped while enrolled in foreign channels/)

      // Remove from Beta
      await ctx.agentTeam.removeChannelMember({
        requestId: requestId('remove-beta'),
        workspaceId: beta,
        channelRef: chanBeta.channel.channelRef,
        memberId,
      })

      // Now demotion succeeds (still in Alpha, which is home workspace)
      const demoted = await ctx.agentTeam.updateMember({
        requestId: requestId('demote-success-multi'),
        memberId,
        handle: 'global-coordinator',
        description: 'Successfully local to Alpha',
        isGlobal: false,
      })
      expect(isGlobalMember(demoted.status.member)).toBe(false)

      // Cold replay ledger validates the entire operation sequence
      const cold = replayLedger(facility)
      expect(() => cold.validate()).not.toThrow()
    })
  })

  describe('2. Mention dispatch: enrolled vs not enrolled in foreign channels', () => {
    it('accepts mentions of global agents in foreign channels when enrolled, rejects when not enrolled', async () => {
      const { ctx } = await harness()

      // Provision global agent in Alpha
      const globalAgent = await ctx.agentTeam.addMember({
        requestId: requestId('mention-agent-global'),
        workspaceId: alpha,
        handle: 'mention-global',
        description: 'Mentionable global',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })
      const gMemberId = globalAgent.status.member.memberId

      // Provision local agent in Alpha
      const localAlpha = await ctx.agentTeam.addMember({
        requestId: requestId('mention-agent-local'),
        workspaceId: alpha,
        handle: 'mention-local-alpha',
        description: 'Local Alpha agent',
        presetId: 'general',
        channelRefs: [],
      })
      const lMemberId = localAlpha.status.member.memberId

      // Create channel 1 in Beta
      const betaChan1 = await ctx.agentTeam.createChannel({
        requestId: requestId('chan-beta-1'),
        workspaceId: beta,
        name: 'beta-chan-1',
        description: 'Beta channel 1',
      })
      const c1Ref = betaChan1.channel.channelRef

      // Create channel 2 in Beta
      const betaChan2 = await ctx.agentTeam.createChannel({
        requestId: requestId('chan-beta-2'),
        workspaceId: beta,
        name: 'beta-chan-2',
        description: 'Beta channel 2',
      })
      const c2Ref = betaChan2.channel.channelRef

      // Enroll global agent in betaChan1 only (NOT betaChan2)
      await ctx.agentTeam.joinChannel({
        requestId: requestId('join-beta-1'),
        workspaceId: beta,
        channelRef: c1Ref,
        memberId: gMemberId,
      })

      // 1. Mention in betaChan1 where global agent IS enrolled -> SUCCEEDS
      const mentionSuccess = await ctx.agentTeam.sendMessage({
        requestId: requestId('mention-c1-success'),
        workspaceId: beta,
        channelRef: c1Ref,
        body: 'Hello @mention-global in C1!',
        recipients: [gMemberId],
      })
      expect(mentionSuccess.kind).toBe('committed')
      if (mentionSuccess.kind === 'committed') {
        expect(mentionSuccess.directMarkers.some(m => m.memberId === gMemberId)).toBe(true)
      }

      // 2. Mention in betaChan2 where global agent is NOT enrolled -> REJECTED
      await expect(ctx.agentTeam.sendMessage({
        requestId: requestId('mention-c2-fail-not-enrolled'),
        workspaceId: beta,
        channelRef: c2Ref,
        body: 'Hello @mention-global in C2 where you are not enrolled!',
        recipients: [gMemberId],
      })).rejects.toThrow(/is not authorized for Channel|invalid Message mention target/)

      // 3. Mention in betaChan1 of local Alpha agent -> REJECTED
      await expect(ctx.agentTeam.sendMessage({
        requestId: requestId('mention-c1-fail-local-alpha'),
        workspaceId: beta,
        channelRef: c1Ref,
        body: 'Hello @mention-local-alpha in Beta C1!',
        recipients: [lMemberId],
      })).rejects.toThrow(/is not authorized for Channel|invalid Message mention target/)

      // 4. Thread reply mentioning unenrolled global agent -> REJECTED
      if (mentionSuccess.kind === 'committed') {
        await expect(ctx.agentTeam.reply({
          requestId: requestId('reply-mention-fail-unenrolled'),
          workspaceId: beta,
          taskRef: mentionSuccess.task!.taskRef,
          body: 'Reply mentioning local agent',
          recipients: [lMemberId],
          baseRevision: mentionSuccess.thread.revision,
        })).rejects.toThrow(/is not authorized for Channel/)
      }

      // 5. Mention enrolled global agent after it is ARCHIVED -> REJECTED
      // Create channel 3 in Beta, enroll global agent, then archive global agent
      const betaChan3 = await ctx.agentTeam.createChannel({
        requestId: requestId('chan-beta-3'),
        workspaceId: beta,
        name: 'beta-chan-3',
        description: 'Beta channel 3',
        memberIds: [gMemberId],
      })
      await ctx.agentTeam.archiveMember({
        requestId: requestId('archive-global-agent'),
        memberId: gMemberId,
      })

      // Now attempt to mention archived global agent in betaChan3
      await expect(ctx.agentTeam.sendMessage({
        requestId: requestId('mention-archived-global-fail'),
        workspaceId: beta,
        channelRef: betaChan3.channel.channelRef,
        body: 'Hello archived agent',
        recipients: [gMemberId],
      })).rejects.toThrow(/is not authorized for Channel/)
    })
  })

  describe('3. Archival and state changes: propagation across workspace client views', () => {
    it('checks membersForClient state reflection in foreign workspaces', async () => {
      const { ctx } = await harness()

      const globalAgent = await ctx.agentTeam.addMember({
        requestId: requestId('state-agent-global'),
        workspaceId: alpha,
        handle: 'state-global',
        description: 'State tracking agent',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })
      const gMemberId = globalAgent.status.member.memberId

      // Initially enabled in foreign workspace Beta
      const betaMembers1 = ctx.agentTeam.membersForClient({ workspaceId: beta })
      const gBeta1 = betaMembers1.find(m => m.member.memberId === gMemberId)
      expect(gBeta1).toBeDefined()
      expect(gBeta1!.member.state).toBe('enabled')

      // Suspend global agent
      await ctx.agentTeam.suspendMember({
        requestId: requestId('suspend-g-agent'),
        memberId: gMemberId,
      })

      // Querying membersForClient in Beta directly reflects suspended state
      const betaMembers2 = ctx.agentTeam.membersForClient({ workspaceId: beta })
      const gBeta2 = betaMembers2.find(m => m.member.memberId === gMemberId)
      expect(gBeta2).toBeDefined()
      expect(gBeta2!.member.state).toBe('suspended')

      // Resume global agent
      await ctx.agentTeam.resumeMember({
        requestId: requestId('resume-g-agent'),
        memberId: gMemberId,
      })
      const betaMembers3 = ctx.agentTeam.membersForClient({ workspaceId: beta })
      const gBeta3 = betaMembers3.find(m => m.member.memberId === gMemberId)
      expect(gBeta3).toBeDefined()
      expect(gBeta3!.member.state).toBe('enabled')

      // Archive global agent
      await ctx.agentTeam.archiveMember({
        requestId: requestId('archive-g-agent'),
        memberId: gMemberId,
      })
      const betaMembers4 = ctx.agentTeam.membersForClient({ workspaceId: beta })
      const gBeta4 = betaMembers4.find(m => m.member.memberId === gMemberId)
      expect(gBeta4).toBeDefined()
      expect(gBeta4!.member.state).toBe('archived')
    })

    it('probes changeScopesOf and change notifications across foreign workspace client watchers', async () => {
      const { ctx } = await harness()
      const ledger = (ctx.agentTeam as unknown as { requireLedger: () => AgentTeamLedger }).requireLedger()

      // 1. Add global agent in Alpha
      const globalAgent = await ctx.agentTeam.addMember({
        requestId: requestId('probe-add-global'),
        workspaceId: alpha,
        handle: 'probe-global',
        description: 'Probe global agent',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })
      const gMemberId = globalAgent.status.member.memberId

      // For team/member-added with isGlobal: true -> changeScopesOf is undefined (global broadcast)
      const addOp = ledger.getOperation(globalAgent.receipt.operationId)!
      expect(ledger.changeScopesOf(addOp)).toBeUndefined()

      // 2. Suspend global agent
      const baselineVersion = (await ctx.agentTeam.changes({ afterVersion: 0 })).version
      const waiterAlpha = ctx.agentTeam.changes({ afterVersion: baselineVersion, scope: { kind: 'workspace', workspaceId: alpha } })
      const waiterBeta = ctx.agentTeam.changes({ afterVersion: baselineVersion, scope: { kind: 'workspace', workspaceId: beta } })

      const suspendRes = await ctx.agentTeam.suspendMember({
        requestId: requestId('probe-suspend-global'),
        memberId: gMemberId,
      })
      const suspendOp = ledger.getOperation(suspendRes.receipt.operationId)!

      // CHALLENGE CHECK: What does ledger.changeScopesOf(suspendOp) return?
      const suspendScopes = ledger.changeScopesOf(suspendOp)
      console.log('suspendScopes for global agent:', suspendScopes)

      // Waiter for home workspace Alpha should wake
      expect(await waiterAlpha).toMatchObject({ version: expect.any(Number) })

      // Does Waiter for foreign workspace Beta wake or stay pending?
      const betaPendingOnSuspend = await staysPending(waiterBeta, 30)
      console.log('Is Beta waiter stuck pending on suspend?', betaPendingOnSuspend)

      // 3. Archive global agent
      const v2 = (await ctx.agentTeam.changes({ afterVersion: 0 })).version
      const waiterAlphaArchive = ctx.agentTeam.changes({ afterVersion: v2, scope: { kind: 'workspace', workspaceId: alpha } })
      const waiterBetaArchive = ctx.agentTeam.changes({ afterVersion: v2, scope: { kind: 'workspace', workspaceId: beta } })

      const archiveRes = await ctx.agentTeam.archiveMember({
        requestId: requestId('probe-archive-global'),
        memberId: gMemberId,
      })
      const archiveOp = ledger.getOperation(archiveRes.receipt.operationId)!

      const archiveScopes = ledger.changeScopesOf(archiveOp)
      console.log('archiveScopes for global agent:', archiveScopes)

      expect(await waiterAlphaArchive).toMatchObject({ version: expect.any(Number) })
      const betaPendingOnArchive = await staysPending(waiterBetaArchive, 30)
      console.log('Is Beta waiter stuck pending on archive?', betaPendingOnArchive)

      // Verify whether changeScopesOf returned undefined for global agent suspend and archive
      // In Milestone 1 worker implementation:
      // case 'team/member-suspended': returns [{ kind: 'workspace', workspaceId: alpha }]
      // case 'team/member-archived': returns [{ kind: 'workspace', workspaceId: alpha }, ...]
      // This means foreign workspaces (Beta, Gamma, Delta) are NOT woken up by change notifications!
    })
  })
})
