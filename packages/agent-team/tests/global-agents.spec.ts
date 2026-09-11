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
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

interface TestHarness {
  readonly ctx: Context
  readonly facility: DomainFacility
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

describe('Global Agent Support (Milestone 1)', () => {
  describe('F1: Global Agent Type & Schema', () => {
    it('creates an agent with isGlobal: true and verifies isGlobalMember helper', async () => {
      const { ctx } = await harness()

      const res = await ctx.agentTeam.addMember({
        requestId: requestId('add-global-1'),
        workspaceId: alpha,
        handle: 'global-assistant',
        description: 'A global cross-workspace agent',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })

      expect(res.status.member.isGlobal).toBe(true)
      expect(isGlobalMember(res.status.member)).toBe(true)
      expect(res.status.member.workspaceId).toBe(alpha)

      // Create a normal workspace-scoped agent
      const localRes = await ctx.agentTeam.addMember({
        requestId: requestId('add-local-1'),
        workspaceId: alpha,
        handle: 'local-assistant',
        description: 'A local agent',
        presetId: 'general',
        channelRefs: [],
      })

      expect(localRes.status.member.isGlobal).toBeUndefined()
      expect(isGlobalMember(localRes.status.member)).toBe(false)
    })
  })

  describe('F2: Ledger Invariant Relaxation & Demotion Guard', () => {
    it('allows a global agent to join and be removed from channels in multiple foreign workspaces', async () => {
      const { ctx } = await harness()

      // Create global agent in Workspace Alpha
      const globalAgent = await ctx.agentTeam.addMember({
        requestId: requestId('agent-alpha-global'),
        workspaceId: alpha,
        handle: 'omniscient',
        description: 'Cross-workspace assistant',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })

      // Create channels in Workspace Beta and Workspace Gamma
      const betaChannel = await ctx.agentTeam.createChannel({
        requestId: requestId('create-beta-chan'),
        workspaceId: beta,
        name: 'beta-channel',
        description: 'Beta workspace channel',
      })

      const gammaChannel = await ctx.agentTeam.createChannel({
        requestId: requestId('create-gamma-chan'),
        workspaceId: gamma,
        name: 'gamma-channel',
        description: 'Gamma workspace channel',
      })

      // Enroll global agent into Beta channel
      const joinBeta = await ctx.agentTeam.joinChannel({
        requestId: requestId('join-beta'),
        workspaceId: beta,
        channelRef: betaChannel.channel.channelRef,
        memberId: globalAgent.status.member.memberId,
      })
      expect(joinBeta.channelRef).toBe(betaChannel.channel.channelRef)

      // Enroll global agent into Gamma channel
      const joinGamma = await ctx.agentTeam.joinChannel({
        requestId: requestId('join-gamma'),
        workspaceId: gamma,
        channelRef: gammaChannel.channel.channelRef,
        memberId: globalAgent.status.member.memberId,
      })
      expect(joinGamma.channelRef).toBe(gammaChannel.channel.channelRef)

      // Remove global agent from Gamma channel
      const removeGamma = await ctx.agentTeam.removeChannelMember({
        requestId: requestId('remove-gamma'),
        workspaceId: gamma,
        channelRef: gammaChannel.channel.channelRef,
        memberId: globalAgent.status.member.memberId,
      })
      expect(removeGamma.channelRef).toBe(gammaChannel.channel.channelRef)
    })

    it('rejects foreign workspace channel enrollment for workspace-scoped agents', async () => {
      const { ctx } = await harness()

      // Create workspace-scoped agent in Alpha
      const localAgent = await ctx.agentTeam.addMember({
        requestId: requestId('agent-alpha-local'),
        workspaceId: alpha,
        handle: 'local-only',
        description: 'Local assistant',
        presetId: 'general',
        channelRefs: [],
        isGlobal: false,
      })

      // Create channel in Beta
      const betaChannel = await ctx.agentTeam.createChannel({
        requestId: requestId('beta-chan-1'),
        workspaceId: beta,
        name: 'beta-only',
        description: 'Beta only channel',
      })

      // Attempt to enroll local Alpha agent in Beta channel -> rejected
      await expect(ctx.agentTeam.joinChannel({
        requestId: requestId('join-fail'),
        workspaceId: beta,
        channelRef: betaChannel.channel.channelRef,
        memberId: localAgent.status.member.memberId,
      })).rejects.toThrow(/Member and Channel must belong to one Workspace|does not belong to Workspace/)
    })

    it('allows cross-workspace @mentions for global agents and rejects for local agents', async () => {
      const { ctx } = await harness()

      // Global agent in Alpha
      const globalAgent = await ctx.agentTeam.addMember({
        requestId: requestId('mention-global-agent'),
        workspaceId: alpha,
        handle: 'polymath',
        description: 'Polymath global agent',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })

      // Local agent in Alpha
      const localAgent = await ctx.agentTeam.addMember({
        requestId: requestId('mention-local-agent'),
        workspaceId: alpha,
        handle: 'specialist',
        description: 'Specialist local agent',
        presetId: 'general',
        channelRefs: [],
      })

      // Channel in Beta
      const betaChannel = await ctx.agentTeam.createChannel({
        requestId: requestId('mention-chan-beta'),
        workspaceId: beta,
        name: 'discussions',
        description: 'Discussions in Beta',
      })

      // Enroll global agent in Beta channel
      await ctx.agentTeam.joinChannel({
        requestId: requestId('mention-join-beta'),
        workspaceId: beta,
        channelRef: betaChannel.channel.channelRef,
        memberId: globalAgent.status.member.memberId,
      })

      // Mention global agent in Beta channel -> succeeds
      const messageResult = await ctx.agentTeam.sendMessage({
        requestId: requestId('send-mention-global'),
        workspaceId: beta,
        channelRef: betaChannel.channel.channelRef,
        body: 'Hello @polymath, please help us with this task.',
        recipients: [globalAgent.status.member.memberId],
      })
      expect(messageResult.kind).toBe('committed')
      if (messageResult.kind === 'committed') {
        expect(messageResult.message.sender).toBeDefined()
        expect(messageResult.directMarkers.some(m => m.memberId === globalAgent.status.member.memberId)).toBe(true)
      }

      // Mention local Alpha agent in Beta channel -> rejected
      await expect(ctx.agentTeam.sendMessage({
        requestId: requestId('send-mention-local-fail'),
        workspaceId: beta,
        channelRef: betaChannel.channel.channelRef,
        body: 'Hello @specialist, can you see this?',
        recipients: [localAgent.status.member.memberId],
      })).rejects.toThrow(/is not authorized for Channel|invalid Message mention target/)
    })

    it('enforces demotion guard: cannot set isGlobal: false while enrolled in foreign channels', async () => {
      const { ctx } = await harness()

      // Create global agent in Alpha
      const agent = await ctx.agentTeam.addMember({
        requestId: requestId('demote-agent'),
        workspaceId: alpha,
        handle: 'traveller',
        description: 'Traveller agent',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })

      // Create channel in Beta and enroll agent
      const betaChannel = await ctx.agentTeam.createChannel({
        requestId: requestId('demote-chan-beta'),
        workspaceId: beta,
        name: 'beta-outpost',
        description: 'Beta outpost',
      })
      await ctx.agentTeam.joinChannel({
        requestId: requestId('demote-join-beta'),
        workspaceId: beta,
        channelRef: betaChannel.channel.channelRef,
        memberId: agent.status.member.memberId,
      })

      // Try to demote while in Beta channel -> rejected
      await expect(ctx.agentTeam.updateMember({
        requestId: requestId('demote-fail'),
        memberId: agent.status.member.memberId,
        handle: 'traveller',
        description: 'Traveller agent',
        isGlobal: false,
      })).rejects.toThrow(/Cannot demote Agent Member '.*' to workspace-scoped while enrolled in foreign channels/)

      // Remove agent from foreign Beta channel
      await ctx.agentTeam.removeChannelMember({
        requestId: requestId('demote-remove-beta'),
        workspaceId: beta,
        channelRef: betaChannel.channel.channelRef,
        memberId: agent.status.member.memberId,
      })

      // Now demoting succeeds
      const demoted = await ctx.agentTeam.updateMember({
        requestId: requestId('demote-success'),
        memberId: agent.status.member.memberId,
        handle: 'traveller',
        description: 'Now a local agent',
        isGlobal: false,
      })
      expect(isGlobalMember(demoted.status.member)).toBe(false)
    })
  })

  describe('F3: Cross-Workspace Handle Collision', () => {
    it('enforces global handle uniqueness for global agents', async () => {
      const { ctx } = await harness()

      // Create global agent in Alpha with handle "sentinel"
      await ctx.agentTeam.addMember({
        requestId: requestId('create-global-sentinel'),
        workspaceId: alpha,
        handle: 'sentinel',
        description: 'Global sentinel',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })

      // Creating a local agent with handle "sentinel" in Beta is rejected
      await expect(ctx.agentTeam.addMember({
        requestId: requestId('create-local-sentinel-collide'),
        workspaceId: beta,
        handle: 'sentinel',
        description: 'Local sentinel in Beta',
        presetId: 'general',
        channelRefs: [],
        isGlobal: false,
      })).rejects.toThrow(/is already active in Workspace/)

      // Creating another global agent with handle "sentinel" in Beta is rejected
      await expect(ctx.agentTeam.addMember({
        requestId: requestId('create-global-sentinel-collide'),
        workspaceId: beta,
        handle: 'sentinel',
        description: 'Global sentinel in Beta',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })).rejects.toThrow(/is already active in Workspace/)
    })

    it('rejects promoting a local agent to global if handle collides in another workspace', async () => {
      const { ctx } = await harness()

      // Create local agent in Alpha with handle "guardian"
      const alphaAgent = await ctx.agentTeam.addMember({
        requestId: requestId('alpha-guardian'),
        workspaceId: alpha,
        handle: 'guardian',
        description: 'Alpha guardian',
        presetId: 'general',
        channelRefs: [],
      })

      // Create local agent in Beta with handle "guardian" (allowed because both are local to different workspaces)
      await ctx.agentTeam.addMember({
        requestId: requestId('beta-guardian'),
        workspaceId: beta,
        handle: 'guardian',
        description: 'Beta guardian',
        presetId: 'general',
        channelRefs: [],
      })

      // Attempt to update alphaAgent to isGlobal: true -> must fail because "guardian" already exists in Beta
      await expect(ctx.agentTeam.updateMember({
        requestId: requestId('promote-guardian-fail'),
        memberId: alphaAgent.status.member.memberId,
        handle: 'guardian',
        description: 'Alpha guardian promoted',
        isGlobal: true,
      })).rejects.toThrow(/is already active in Workspace/)
    })
  })

  describe('F4: Global Member Change Broadcast', () => {
    it('returns undefined (wake all workspaces) for global member added and updated', async () => {
      const { ctx } = await harness()

      const globalAgent = await ctx.agentTeam.addMember({
        requestId: requestId('scope-global-add'),
        workspaceId: alpha,
        handle: 'broadcaster',
        description: 'Broadcast test agent',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })

      const ledger = (ctx.agentTeam as unknown as { requireLedger: () => AgentTeamLedger }).requireLedger()
      const addOp = ledger.getOperation(globalAgent.receipt.operationId)!
      expect(ledger.changeScopesOf(addOp)).toBeUndefined()

      // Update the global agent
      const updated = await ctx.agentTeam.updateMember({
        requestId: requestId('scope-global-update'),
        memberId: globalAgent.status.member.memberId,
        handle: 'broadcaster-v2',
        description: 'Updated broadcast test agent',
      })
      const updateOp = ledger.getOperation(updated.receipt.operationId)!
      expect(ledger.changeScopesOf(updateOp)).toBeUndefined()

      // Local agent mutations should be scoped strictly to their own workspace
      const localAgent = await ctx.agentTeam.addMember({
        requestId: requestId('scope-local-add'),
        workspaceId: alpha,
        handle: 'narrow-cast',
        description: 'Local agent',
        presetId: 'general',
        channelRefs: [],
      })
      const localAddOp = ledger.getOperation(localAgent.receipt.operationId)!
      expect(ledger.changeScopesOf(localAddOp)).toEqual([{ kind: 'workspace', workspaceId: alpha }])
    })
  })

  describe('F5: Cross-Workspace Client Discovery', () => {
    it('projects global agents in membersForClient across all workspaces', async () => {
      const { ctx } = await harness()

      // Create global agent in Alpha
      await ctx.agentTeam.addMember({
        requestId: requestId('discovery-global'),
        workspaceId: alpha,
        handle: 'wanderer',
        description: 'Visible everywhere',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })

      // Create local agent in Alpha
      await ctx.agentTeam.addMember({
        requestId: requestId('discovery-local-alpha'),
        workspaceId: alpha,
        handle: 'alpha-hermit',
        description: 'Visible only in Alpha',
        presetId: 'general',
        channelRefs: [],
      })

      // Create local agent in Beta
      await ctx.agentTeam.addMember({
        requestId: requestId('discovery-local-beta'),
        workspaceId: beta,
        handle: 'beta-hermit',
        description: 'Visible only in Beta',
        presetId: 'general',
        channelRefs: [],
      })

      // Query membersForClient in Alpha: should have globalAgent and localAlpha, NOT localBeta
      const alphaMembers = ctx.agentTeam.membersForClient({ workspaceId: alpha })
      const alphaHandles = alphaMembers.map(m => m.member.handle)
      expect(alphaHandles).toContain('wanderer')
      expect(alphaHandles).toContain('alpha-hermit')
      expect(alphaHandles).not.toContain('beta-hermit')

      // Query membersForClient in Beta: should have globalAgent and localBeta, NOT localAlpha
      const betaMembers = ctx.agentTeam.membersForClient({ workspaceId: beta })
      const betaHandles = betaMembers.map(m => m.member.handle)
      expect(betaHandles).toContain('wanderer')
      expect(betaHandles).toContain('beta-hermit')
      expect(betaHandles).not.toContain('alpha-hermit')

      // Query membersForClient in Gamma: should have globalAgent, NOT localAlpha or localBeta
      const gammaMembers = ctx.agentTeam.membersForClient({ workspaceId: gamma })
      const gammaHandles = gammaMembers.map(m => m.member.handle)
      expect(gammaHandles).toContain('wanderer')
      expect(gammaHandles).not.toContain('alpha-hermit')
      expect(gammaHandles).not.toContain('beta-hermit')
    })
  })

  describe('F6: Ledger Replay Validation', () => {
    it('successfully validates complete ledger with cross-workspace global agents on cold replay', async () => {
      const { ctx, facility } = await harness()

      // Set up multi-workspace operations
      const globalAgent = await ctx.agentTeam.addMember({
        requestId: requestId('replay-global-1'),
        workspaceId: alpha,
        handle: 'archon',
        description: 'Replay test global agent',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })

      const betaChan = await ctx.agentTeam.createChannel({
        requestId: requestId('replay-beta-chan'),
        workspaceId: beta,
        name: 'archon-staging',
        description: 'Staging channel in Beta',
      })

      await ctx.agentTeam.joinChannel({
        requestId: requestId('replay-join-beta'),
        workspaceId: beta,
        channelRef: betaChan.channel.channelRef,
        memberId: globalAgent.status.member.memberId,
      })

      await ctx.agentTeam.sendMessage({
        requestId: requestId('replay-send-msg'),
        workspaceId: beta,
        channelRef: betaChan.channel.channelRef,
        body: 'Welcome @archon to Beta!',
        recipients: [globalAgent.status.member.memberId],
      })

      await ctx.agentTeam.updateMember({
        requestId: requestId('replay-update-global'),
        memberId: globalAgent.status.member.memberId,
        handle: 'archon-prime',
        description: 'Elevated global agent',
      })

      // Now create a cold replay ledger and validate all recorded operations
      const coldLedger = replayLedger(facility)
      expect(() => coldLedger.validate()).not.toThrow()
    })
  })

  describe('F7: Cross-Workspace Views and Initial Channel Enrollment', () => {
    it('allows a global agent to be an initial member of a channel created in another workspace', async () => {
      const { ctx } = await harness()

      const globalAgent = await ctx.agentTeam.addMember({
        requestId: requestId('init-global-agent'),
        workspaceId: alpha,
        handle: 'catalyst',
        description: 'Global catalyst',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })

      // Create channel in Beta with global agent as an initial member
      const betaChan = await ctx.agentTeam.createChannel({
        requestId: requestId('init-beta-chan'),
        workspaceId: beta,
        name: 'cross-collab',
        description: 'Cross-workspace collaboration',
        memberIds: [globalAgent.status.member.memberId],
      })

      expect(betaChan.memberIds).toContain(globalAgent.status.member.memberId)

      // Replay validation must succeed
      const ledger = (ctx.agentTeam as unknown as { requireLedger: () => AgentTeamLedger }).requireLedger()
      expect(() => ledger.validate()).not.toThrow()
    })

    it('rejects a local agent as an initial member of a channel in another workspace', async () => {
      const { ctx } = await harness()

      const localAgent = await ctx.agentTeam.addMember({
        requestId: requestId('local-agent-init'),
        workspaceId: alpha,
        handle: 'desk-worker',
        description: 'Alpha only',
        presetId: 'general',
        channelRefs: [],
        isGlobal: false,
      })

      await expect(ctx.agentTeam.createChannel({
        requestId: requestId('fail-beta-init'),
        workspaceId: beta,
        name: 'remote-team',
        description: 'Should fail',
        memberIds: [localAgent.status.member.memberId],
      })).rejects.toThrow(/does not belong to Workspace|is not available for Channel membership/)
    })

    it('allows global agents to view and access foreign workspaces via ledger and host', async () => {
      const { ctx } = await harness()

      const globalAgent = await ctx.agentTeam.addMember({
        requestId: requestId('view-global-agent'),
        workspaceId: alpha,
        handle: 'scout',
        description: 'Global scout',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      })

      const betaChan = await ctx.agentTeam.createChannel({
        requestId: requestId('scout-beta-chan'),
        workspaceId: beta,
        name: 'scout-outpost',
        description: 'Scout outpost',
      })

      await ctx.agentTeam.joinChannel({
        requestId: requestId('scout-join-beta'),
        workspaceId: beta,
        channelRef: betaChan.channel.channelRef,
        memberId: globalAgent.status.member.memberId,
      })

      const ledger = (ctx.agentTeam as unknown as { requireLedger: () => AgentTeamLedger }).requireLedger()

      // Ledger view for global agent on foreign workspace succeeds
      const betaView = ledger.view({ workspaceId: beta }, globalAgent.status.member.memberId)
      expect(betaView.channels.some(c => c.channelRef === betaChan.channel.channelRef)).toBe(true)

      // Local agent in Alpha viewing Beta must fail
      const localAgent = await ctx.agentTeam.addMember({
        requestId: requestId('local-viewer'),
        workspaceId: alpha,
        handle: 'homebody',
        description: 'Local viewer',
        presetId: 'general',
        channelRefs: [],
      })

      expect(() => ledger.view({ workspaceId: beta }, localAgent.status.member.memberId))
        .toThrow(/Member cannot view another Workspace/)
    })
  })

  describe('F8: Idempotency & Deduplication', () => {
    it('idempotently dedupes global agent additions and updates', async () => {
      const { ctx } = await harness()

      const addReq = {
        requestId: requestId('idem-global-1'),
        workspaceId: alpha,
        handle: 'idempotent-agent',
        description: 'Testing idempotency',
        presetId: 'general',
        channelRefs: [],
        isGlobal: true,
      }

      const res1 = await ctx.agentTeam.addMember(addReq)
      const res2 = await ctx.agentTeam.addMember(addReq)
      expect(res1.receipt.operationId).toBe(res2.receipt.operationId)

      // Changing isGlobal on retry throws request collision error
      await expect(ctx.agentTeam.addMember({
        ...addReq,
        isGlobal: false,
      })).rejects.toThrow()
    })
  })
})
