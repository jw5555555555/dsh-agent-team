import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import AgentTeam from '../src/index.ts'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
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
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

interface TestHarness {
  readonly ctx: Context
  readonly facility: DomainFacility
  readonly ledger: AgentTeamLedger
  readonly table: KvTable<AgentTeamOperationId, AgentTeamOperation>
}

async function harness(pool = new MemoryMediaPool()): Promise<TestHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const allWorkspaces = [alpha, beta, gamma]
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
        inbox: { nextTurn: [], nextStep: [] },
        session: { ownEvents: () => [] },
        steer: () => {},
        followup: () => {},
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
  const table = facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>
  const ledger = (ctx.agentTeam as unknown as { requireLedger: () => AgentTeamLedger }).requireLedger()
  return { ctx, facility, ledger, table }
}

function replayLedger(facility: DomainFacility): AgentTeamLedger {
  return new AgentTeamLedger(facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
}

describe('Adversarial Challenge: Milestone 1 (Domain & Ledger Core)', () => {
  // =========================================================================
  // Challenge 1: Workspace-scoped Agent Foreign Channel Isolation Bypass
  // =========================================================================
  describe('Challenge 1: Isolation Bypass Stress-Testing', () => {
    it('1.1: strictly rejects local agent joining a foreign channel via joinChannel', async () => {
      const { ctx } = await harness()

      const localAgent = await ctx.agentTeam.addMember({
        requestId: requestId('c1-local-alpha'),
        workspaceId: alpha,
        handle: 'alpha-worker',
        description: 'Alpha worker',
        presetId: 'general',
        channelRefs: [],
      })

      const betaChan = await ctx.agentTeam.createChannel({
        requestId: requestId('c1-chan-beta'),
        workspaceId: beta,
        name: 'beta-confidential',
        description: 'Confidential Beta Channel',
      })

      await expect(ctx.agentTeam.joinChannel({
        requestId: requestId('c1-bypass-join'),
        workspaceId: beta,
        channelRef: betaChan.channel.channelRef,
        memberId: localAgent.status.member.memberId,
      })).rejects.toThrow(/Member and Channel must belong to one Workspace|does not belong to Workspace/)
    })

    it('1.2: strictly rejects local agent in foreign channel creation initial memberIds', async () => {
      const { ctx } = await harness()

      const localAgent = await ctx.agentTeam.addMember({
        requestId: requestId('c1-local-alpha-2'),
        workspaceId: alpha,
        handle: 'alpha-worker-2',
        description: 'Alpha worker 2',
        presetId: 'general',
        channelRefs: [],
      })

      await expect(ctx.agentTeam.createChannel({
        requestId: requestId('c1-create-chan-beta-with-alpha-member'),
        workspaceId: beta,
        name: 'beta-with-infiltrator',
        description: 'Attempted cross-workspace channel creation',
        memberIds: [localAgent.status.member.memberId],
      })).rejects.toThrow(/does not belong to Workspace|is not available for Channel membership/)
    })

    it('1.3: strictly rejects local agent viewing foreign workspace', async () => {
      const { ctx, ledger } = await harness()

      const localAgent = await ctx.agentTeam.addMember({
        requestId: requestId('c1-local-alpha-3'),
        workspaceId: alpha,
        handle: 'alpha-worker-3',
        description: 'Alpha worker 3',
        presetId: 'general',
        channelRefs: [],
      })

      expect(() => ledger.view({ workspaceId: beta }, localAgent.status.member.memberId))
        .toThrow(/Member cannot view another Workspace/)
    })

    it('1.4: strictly rejects mentioning a local agent in a foreign channel', async () => {
      const { ctx } = await harness()

      const localAlpha = await ctx.agentTeam.addMember({
        requestId: requestId('c1-local-alpha-4'),
        workspaceId: alpha,
        handle: 'alpha-silo',
        description: 'Siloed Alpha worker',
        presetId: 'general',
        channelRefs: [],
      })

      const betaChan = await ctx.agentTeam.createChannel({
        requestId: requestId('c1-chan-beta-4'),
        workspaceId: beta,
        name: 'beta-talk',
        description: 'Beta Talk',
      })

      await expect(ctx.agentTeam.sendMessage({
        requestId: requestId('c1-send-mention-local'),
        workspaceId: beta,
        channelRef: betaChan.channel.channelRef,
        body: 'Leaking data to @alpha-silo',
        recipients: [localAlpha.status.member.memberId],
      })).rejects.toThrow(/is not authorized for Channel|invalid Message mention target/)
    })

    it('1.5: strictly rejects a local agent attempting to act as actor in a foreign workspace mutation', async () => {
      const { ctx, ledger } = await harness()

      const localAlpha = await ctx.agentTeam.addMember({
        requestId: requestId('c1-local-alpha-5'),
        workspaceId: alpha,
        handle: 'alpha-intruder',
        description: 'Intruder',
        presetId: 'general',
        channelRefs: [],
      })

      const betaChan = await ctx.agentTeam.createChannel({
        requestId: requestId('c1-chan-beta-5'),
        workspaceId: beta,
        name: 'beta-locked',
        description: 'Locked Beta',
      })

      // Attempt sending message as localAlpha actor in Workspace Beta
      await expect(ledger.sendMessage({
        actor: { kind: 'member', memberId: localAlpha.status.member.memberId, handle: localAlpha.status.member.handle },
        requestId: requestId('c1-intruder-msg'),
        workspaceId: beta,
        channelRef: betaChan.channel.channelRef,
        body: 'Malicious injection from Alpha',
        asTask: false,
      })).rejects.toThrow(/Member cannot mutate another Workspace/)
    })

    it('1.6: replay validation strictly rejects forged channel-member-added operation for foreign local agent', async () => {
      const { ctx, facility, ledger, table } = await harness()

      const localAlpha = await ctx.agentTeam.addMember({
        requestId: requestId('c1-local-forged'),
        workspaceId: alpha,
        handle: 'victim-agent',
        description: 'Victim',
        presetId: 'general',
        channelRefs: [],
      })

      const betaChan = await ctx.agentTeam.createChannel({
        requestId: requestId('c1-beta-chan-forged'),
        workspaceId: beta,
        name: 'target-chan',
        description: 'Target',
      })

      const lastOp = [...(ledger as any).state.byOperation.values()].pop()!
      // Forged operation: human actor adds localAlpha into betaChan
      const forgedOpId = 'op:forged-join' as AgentTeamOperationId
      const forgedOp: AgentTeamOperation = {
        operationId: forgedOpId,
        sequence: lastOp.sequence + 1,
        previousOperationId: lastOp.operationId,
        requestId: requestId('forged-join'),
        occurredAt: '2026-09-11T12:00:00.000Z',
        actor: agentTeamHumanActor(),
        kind: 'team/channel-member-added',
        data: {
          workspaceId: beta,
          channelRef: betaChan.channel.channelRef,
          memberId: localAlpha.status.member.memberId,
        },
      }
      await table.put(forgedOpId, forgedOp)

      expect(() => replayLedger(facility)).toThrow(/invalid Channel membership/)
    })
  })

  // =========================================================================
  // Challenge 2: Global Agent Multi-Workspace Collaboration & Invariant Health
  // =========================================================================
  describe('Challenge 2: Multi-Workspace Global Agent Invariants', () => {
    it('2.1: allows global agent to join channels and exchange messages across Alpha, Beta, Gamma', async () => {
      const { ctx, ledger } = await harness()

      // Global agent created in Alpha
      const globalAgent = await ctx.agentTeam.addMember({
        requestId: requestId('c2-global-omni'),
        workspaceId: alpha,
        handle: 'omni-bot',
        description: 'Omnipresent bot',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })
      const globalMemberId = globalAgent.status.member.memberId

      // Channels in Alpha, Beta, Gamma
      await ctx.agentTeam.createChannel({
        requestId: requestId('c2-chan-alpha'),
        workspaceId: alpha,
        name: 'alpha-hq',
        description: 'HQ in Alpha',
        memberIds: [globalMemberId],
      })

      const chanBeta = await ctx.agentTeam.createChannel({
        requestId: requestId('c2-chan-beta'),
        workspaceId: beta,
        name: 'beta-field',
        description: 'Field in Beta',
      })
      await ctx.agentTeam.joinChannel({
        requestId: requestId('c2-join-beta'),
        workspaceId: beta,
        channelRef: chanBeta.channel.channelRef,
        memberId: globalMemberId,
      })

      const chanGamma = await ctx.agentTeam.createChannel({
        requestId: requestId('c2-chan-gamma'),
        workspaceId: gamma,
        name: 'gamma-lab',
        description: 'Lab in Gamma',
      })
      await ctx.agentTeam.joinChannel({
        requestId: requestId('c2-join-gamma'),
        workspaceId: gamma,
        channelRef: chanGamma.channel.channelRef,
        memberId: globalMemberId,
      })

      // Send message mentioning global agent in Beta
      const sendBeta = await ctx.agentTeam.sendMessage({
        requestId: requestId('c2-msg-beta'),
        workspaceId: beta,
        channelRef: chanBeta.channel.channelRef,
        body: 'Hello @omni-bot in Beta',
        recipients: [globalMemberId],
      })
      expect(sendBeta.kind).toBe('committed')

      // Global agent acts as actor in Beta to reply
      const replyBeta = await ledger.sendMessage({
        actor: { kind: 'member', memberId: globalMemberId, handle: globalAgent.status.member.handle },
        requestId: requestId('c2-reply-beta'),
        workspaceId: beta,
        channelRef: chanBeta.channel.channelRef,
        body: 'Acknowledged Beta mission',
        asTask: true,
      })
      expect(replyBeta.committed).toBe(true)

      // Global agent acts as actor in Gamma to reply
      const replyGamma = await ledger.sendMessage({
        actor: { kind: 'member', memberId: globalMemberId, handle: globalAgent.status.member.handle },
        requestId: requestId('c2-reply-gamma'),
        workspaceId: gamma,
        channelRef: chanGamma.channel.channelRef,
        body: 'Acknowledged Gamma experiment',
        asTask: true,
      })
      expect(replyGamma.committed).toBe(true)

      // Global agent leaves Gamma channel
      const leaveGamma = await ctx.agentTeam.removeChannelMember({
        requestId: requestId('c2-leave-gamma'),
        workspaceId: gamma,
        channelRef: chanGamma.channel.channelRef,
        memberId: globalMemberId,
      })
      expect(leaveGamma.channelRef).toBe(chanGamma.channel.channelRef)

      // Now sending mention to globalAgent in Gamma channel must be rejected because it left
      await expect(ctx.agentTeam.sendMessage({
        requestId: requestId('c2-mention-left-gamma'),
        workspaceId: gamma,
        channelRef: chanGamma.channel.channelRef,
        body: 'Still there @omni-bot?',
        recipients: [globalMemberId],
      })).rejects.toThrow(/is not authorized for Channel|invalid Message mention target/)

      // But in Beta channel, globalAgent is still a member and can be mentioned
      const sendBeta2 = await ctx.agentTeam.sendMessage({
        requestId: requestId('c2-msg-beta-2'),
        workspaceId: beta,
        channelRef: chanBeta.channel.channelRef,
        body: 'Still here @omni-bot!',
        recipients: [globalMemberId],
      })
      expect(sendBeta2.kind).toBe('committed')
    })
  })

  // =========================================================================
  // Challenge 3: Demotion Guard & State Transition Safety
  // =========================================================================
  describe('Challenge 3: Demotion Guard Stress-Testing', () => {
    it('3.1: rejects demotion when enrolled in foreign channel, but succeeds after removal', async () => {
      const { ctx } = await harness()

      const agent = await ctx.agentTeam.addMember({
        requestId: requestId('c3-agent'),
        workspaceId: alpha,
        handle: 'roamer',
        description: 'Roamer',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })
      const memberId = agent.status.member.memberId

      const foreignChan = await ctx.agentTeam.createChannel({
        requestId: requestId('c3-foreign-chan'),
        workspaceId: beta,
        name: 'beta-collab',
        description: 'Beta Collab',
      })
      await ctx.agentTeam.joinChannel({
        requestId: requestId('c3-join-foreign'),
        workspaceId: beta,
        channelRef: foreignChan.channel.channelRef,
        memberId,
      })

      // Demotion attempt while in Beta channel -> REJECTED
      await expect(ctx.agentTeam.updateMember({
        requestId: requestId('c3-demote-blocked'),
        memberId,
        handle: 'roamer',
        description: 'Roamer local',
        isGlobal: false,
      })).rejects.toThrow(/Cannot demote Agent Member '.*' to workspace-scoped while enrolled in foreign channels/)

      // Verify agent is STILL global
      const current = ctx.agentTeam.membersForClient({ workspaceId: beta })
      expect(current.some(m => m.member.memberId === memberId && m.member.isGlobal === true)).toBe(true)

      // Remove from foreign channel
      await ctx.agentTeam.removeChannelMember({
        requestId: requestId('c3-remove-foreign'),
        workspaceId: beta,
        channelRef: foreignChan.channel.channelRef,
        memberId,
      })

      // Demotion attempt now SUCCEEDS
      const demoted = await ctx.agentTeam.updateMember({
        requestId: requestId('c3-demote-allowed'),
        memberId,
        handle: 'roamer-local',
        description: 'Demoted local agent',
        isGlobal: false,
      })
      expect(isGlobalMember(demoted.status.member)).toBe(false)

      // Demoted agent must now be strictly blocked from joining foreign channels!
      await expect(ctx.agentTeam.joinChannel({
        requestId: requestId('c3-rejoin-blocked'),
        workspaceId: beta,
        channelRef: foreignChan.channel.channelRef,
        memberId,
      })).rejects.toThrow(/Member and Channel must belong to one Workspace|does not belong to Workspace/)
    })

    it('3.2: replay validation catches forged demotion operation while in foreign channel', async () => {
      const { ctx, facility, ledger, table } = await harness()

      const agent = await ctx.agentTeam.addMember({
        requestId: requestId('c3-replay-agent'),
        workspaceId: alpha,
        handle: 'wanderer-forged',
        description: 'Wanderer',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })
      const memberId = agent.status.member.memberId

      const foreignChan = await ctx.agentTeam.createChannel({
        requestId: requestId('c3-replay-foreign-chan'),
        workspaceId: beta,
        name: 'beta-post',
        description: 'Beta Post',
      })
      await ctx.agentTeam.joinChannel({
        requestId: requestId('c3-replay-join'),
        workspaceId: beta,
        channelRef: foreignChan.channel.channelRef,
        memberId,
      })

      const lastOp = [...(ledger as any).state.byOperation.values()].pop()!
      // Forged demotion operation directly written to table without removing from foreign channel
      const forgedDemoteOpId = 'op:forged-demote' as AgentTeamOperationId
      const priorMember = agent.status.member
      const forgedDemoteOp: AgentTeamOperation = {
        operationId: forgedDemoteOpId,
        sequence: lastOp.sequence + 1,
        previousOperationId: lastOp.operationId,
        requestId: requestId('forged-demote'),
        occurredAt: '2026-09-11T12:00:00.000Z',
        actor: agentTeamHumanActor(),
        kind: 'team/member-updated',
        data: {
          member: {
            ...priorMember,
            isGlobal: undefined,
          },
        },
      }
      await table.put(forgedDemoteOpId, forgedDemoteOp)

      expect(() => replayLedger(facility)).toThrow(/invalid Member demotion/)
    })
  })

  // =========================================================================
  // Challenge 4: Handle Collision Across Local and Global Agents
  // =========================================================================
  describe('Challenge 4: Handle Collision Enforcement', () => {
    it('4.1: rejects creating a local agent with an existing global agent handle in another workspace', async () => {
      const { ctx } = await harness()

      await ctx.agentTeam.addMember({
        requestId: requestId('c4-global-prime'),
        workspaceId: alpha,
        handle: 'overseer',
        description: 'Global overseer',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })

      // Try creating local agent in Beta with same handle
      await expect(ctx.agentTeam.addMember({
        requestId: requestId('c4-local-beta-collide'),
        workspaceId: beta,
        handle: 'overseer',
        description: 'Colliding local in Beta',
        presetId: 'general',
        channelRefs: [],
        isGlobal: false,
      })).rejects.toThrow(/is already active in Workspace/)

      // Case insensitivity & normalization collision
      await expect(ctx.agentTeam.addMember({
        requestId: requestId('c4-local-beta-collide-case'),
        workspaceId: beta,
        handle: 'Overseer',
        description: 'Case collision',
        presetId: 'general',
        channelRefs: [],
        isGlobal: false,
      })).rejects.toThrow(/is already active in Workspace/)
    })

    it('4.2: rejects creating a global agent with an existing local agent handle in another workspace', async () => {
      const { ctx } = await harness()

      await ctx.agentTeam.addMember({
        requestId: requestId('c4-local-beta-first'),
        workspaceId: beta,
        handle: 'special-ops',
        description: 'Local Beta ops',
        presetId: 'general',
        channelRefs: [],
        isGlobal: false,
      })

      // Try creating global agent in Alpha with same handle
      await expect(ctx.agentTeam.addMember({
        requestId: requestId('c4-global-alpha-collide'),
        workspaceId: alpha,
        handle: 'special-ops',
        description: 'Colliding global',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })).rejects.toThrow(/is already active in Workspace/)
    })

    it('4.3: allows identical handles between two local agents in different workspaces, but blocks promotion to global', async () => {
      const { ctx } = await harness()

      // Local agent in Alpha
      const alphaLocal = await ctx.agentTeam.addMember({
        requestId: requestId('c4-alpha-worker'),
        workspaceId: alpha,
        handle: 'builder',
        description: 'Alpha builder',
        presetId: 'general',
        channelRefs: [],
      })

      // Local agent in Beta with same handle is ALLOWED (different workspaces, neither is global)
      const betaLocal = await ctx.agentTeam.addMember({
        requestId: requestId('c4-beta-worker'),
        workspaceId: beta,
        handle: 'builder',
        description: 'Beta builder',
        presetId: 'general',
        channelRefs: [],
      })
      expect(alphaLocal.status.member.handle).toBe('builder')
      expect(betaLocal.status.member.handle).toBe('builder')

      // But promoting Alpha local to global must FAIL due to collision with Beta local
      await expect(ctx.agentTeam.updateMember({
        requestId: requestId('c4-promote-fail'),
        memberId: alphaLocal.status.member.memberId,
        handle: 'builder',
        description: 'Promoted builder',
        isGlobal: true,
      })).rejects.toThrow(/is already active in Workspace/)
    })
  })

  // =========================================================================
  // Challenge 5: Ledger Replay & State Drift Verification
  // =========================================================================
  describe('Challenge 5: Ledger Replay & State Drift Verification', () => {
    it('5.1: replays complex multi-workspace global agent ledger with zero errors and zero state drift', async () => {
      const { ctx, facility, ledger } = await harness()

      // 1. Create global agent 1
      const g1 = await ctx.agentTeam.addMember({
        requestId: requestId('c5-g1'),
        workspaceId: alpha,
        handle: 'architect',
        description: 'System architect',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })

      // 2. Create local agent in Alpha
      const lAlpha = await ctx.agentTeam.addMember({
        requestId: requestId('c5-lalpha'),
        workspaceId: alpha,
        handle: 'frontend-dev',
        description: 'Frontend Dev',
        presetId: 'general',
        channelRefs: [],
      })

      // 3. Create channels in Alpha and Beta
      const cAlpha = await ctx.agentTeam.createChannel({
        requestId: requestId('c5-calpha'),
        workspaceId: alpha,
        name: 'alpha-dev',
        description: 'Alpha Dev Channel',
        memberIds: [g1.status.member.memberId, lAlpha.status.member.memberId],
      })

      const cBeta = await ctx.agentTeam.createChannel({
        requestId: requestId('c5-cbeta'),
        workspaceId: beta,
        name: 'beta-dev',
        description: 'Beta Dev Channel',
        memberIds: [g1.status.member.memberId],
      })

      // 4. Send messages with mentions in Alpha and Beta
      await ctx.agentTeam.sendMessage({
        requestId: requestId('c5-msg1'),
        workspaceId: alpha,
        channelRef: cAlpha.channel.channelRef,
        body: 'Hello @architect and @frontend-dev',
        recipients: [g1.status.member.memberId, lAlpha.status.member.memberId],
      })

      await ctx.agentTeam.sendMessage({
        requestId: requestId('c5-msg2'),
        workspaceId: beta,
        channelRef: cBeta.channel.channelRef,
        body: 'Welcome @architect to Beta',
        recipients: [g1.status.member.memberId],
      })

      // 5. Update global agent handle
      await ctx.agentTeam.updateMember({
        requestId: requestId('c5-update-g1'),
        memberId: g1.status.member.memberId,
        handle: 'chief-architect',
        description: 'Chief System Architect',
        isGlobal: true,
      })

      // 6. Create global agent 2, enroll in Beta, remove from Beta, demote to local
      const g2 = await ctx.agentTeam.addMember({
        requestId: requestId('c5-g2'),
        workspaceId: alpha,
        handle: 'temp-advisor',
        description: 'Temporary Advisor',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })

      await ctx.agentTeam.joinChannel({
        requestId: requestId('c5-g2-join-beta'),
        workspaceId: beta,
        channelRef: cBeta.channel.channelRef,
        memberId: g2.status.member.memberId,
      })

      await ctx.agentTeam.removeChannelMember({
        requestId: requestId('c5-g2-remove-beta'),
        workspaceId: beta,
        channelRef: cBeta.channel.channelRef,
        memberId: g2.status.member.memberId,
      })

      await ctx.agentTeam.updateMember({
        requestId: requestId('c5-demote-g2'),
        memberId: g2.status.member.memberId,
        handle: 'local-advisor',
        description: 'Now local advisor',
        isGlobal: false,
      })

      // Verify active ledger validates
      expect(() => ledger.validate()).not.toThrow()

      // Now create cold replayed ledger
      const cold = replayLedger(facility)
      expect(() => cold.validate()).not.toThrow()

      // Verify ZERO state drift between active ledger and replayed ledger
      const activeState = (ledger as any).state
      const coldState = (cold as any).state

      // Member count and members map
      expect(coldState.members.size).toBe(activeState.members.size)
      for (const [memberId, member] of activeState.members.entries()) {
        const replayedMember = coldState.members.get(memberId)
        expect(replayedMember).toBeDefined()
        expect(replayedMember).toEqual(member)
      }

      // Channels map
      expect(coldState.channels.size).toBe(activeState.channels.size)
      for (const [channelRef, channel] of activeState.channels.entries()) {
        const replayedChannel = coldState.channels.get(channelRef)
        expect(replayedChannel).toBeDefined()
        expect(replayedChannel).toEqual(channel)
      }

      // Memberships map
      expect(coldState.memberships.size).toBe(activeState.memberships.size)
      for (const [channelRef, memberSet] of activeState.memberships.entries()) {
        const replayedMemberSet = coldState.memberships.get(channelRef)
        expect(replayedMemberSet).toBeDefined()
        expect([...replayedMemberSet!].sort()).toEqual([...memberSet].sort())
      }

      // Messages list
      expect(coldState.messages).toEqual(activeState.messages)
    })
  })

  // =========================================================================
  // Challenge Area: Boundary Edge Cases (Initial Channels in Foreign Workspace)
  // =========================================================================
  describe('Adversarial Investigation: Initial Foreign Channel Enrollment', () => {
    it('investigate: creating global agent with initial foreign channelRefs in live addMember', async () => {
      const { ctx } = await harness()

      // Create channel in Beta
      const betaChan = await ctx.agentTeam.createChannel({
        requestId: requestId('adv-beta-chan'),
        workspaceId: beta,
        name: 'beta-target',
        description: 'Beta Target Channel',
      })

      // Attempt to create global agent in Alpha with betaChan in initial channelRefs
      // Note: Replay validation (line 1794) explicitly permits this for global members:
      // if (channel === undefined || (!isGlobalMember(member) && channel.workspaceId !== member.workspaceId))
      // But what does live addMember (line 482) do?
      try {
        await ctx.agentTeam.addMember({
          requestId: requestId('adv-global-with-foreign-channel'),
          workspaceId: alpha,
          handle: 'cross-initial',
          description: 'Initial cross channel agent',
          presetId: 'general',
          channelRefs: [betaChan.channel.channelRef],
          isGlobal: true,
        })
        // If it succeeds, live addMember supports initial foreign channels
      } catch (err: any) {
        // If it throws, record exact error
        expect(err.message).toMatch(/does not belong to Workspace/)
      }
    })
  })
})
