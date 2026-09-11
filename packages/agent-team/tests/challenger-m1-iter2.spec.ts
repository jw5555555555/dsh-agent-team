import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import AgentTeam from '../src/index.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import type { AgentTeamRequestId } from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const beta = WorkspaceId('workspace:beta')
const gamma = WorkspaceId('workspace:gamma')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

async function testHarness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
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
        steer: () => {},
        followup: () => {},
        inbox: {
          nextTurn: [],
          nextStep: [],
          steer: () => {},
          remove: () => false,
          consume: () => {},
        },
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
  return {
    ctx,
    cleanup: async () => {
      await fiber.dispose()
      await facility.closeAll()
    },
  }
}

describe('Challenger Milestone 1 Iteration 2 Empirical Verification', () => {
  describe('Requirement 1: addMember initial foreign channelRefs', () => {
    it('succeeds for global agent with initial foreign channelRefs across multiple foreign workspaces', async () => {
      const { ctx, cleanup } = await testHarness()
      try {
        const betaChannel = await ctx.agentTeam.createChannel({
          requestId: requestId('beta-chan-1'),
          workspaceId: beta,
          name: 'beta-general',
          description: 'Beta channel',
        })
        const gammaChannel = await ctx.agentTeam.createChannel({
          requestId: requestId('gamma-chan-1'),
          workspaceId: gamma,
          name: 'gamma-general',
          description: 'Gamma channel',
        })

        // Add Global Member in Alpha with initial channels in both Beta and Gamma
        const res = await ctx.agentTeam.addMember({
          requestId: requestId('global-cross-chan-multi'),
          workspaceId: alpha,
          handle: 'cross-worker-multi',
          description: 'Global multi worker',
          presetId: 'team-member',
          channelRefs: [betaChannel.channel.channelRef, gammaChannel.channel.channelRef],
          isGlobal: true,
        })

        expect(res.receipt).toBeDefined()
        expect(res.status.member.handle).toBe('cross-worker-multi')
        expect(res.status.member.isGlobal).toBe(true)

        // Verify view in Beta and Gamma confirms membership
        const viewBeta = await ctx.agentTeam.view({ workspaceId: beta })
        const chanInBeta = viewBeta.channels.find(c => c.channelRef === betaChannel.channel.channelRef)
        expect(chanInBeta).toBeDefined()
        expect(viewBeta.members.some(m => m.channelRef === betaChannel.channel.channelRef && m.memberId === res.status.member.memberId)).toBe(true)

        const viewGamma = await ctx.agentTeam.view({ workspaceId: gamma })
        expect(viewGamma.members.some(m => m.channelRef === gammaChannel.channel.channelRef && m.memberId === res.status.member.memberId)).toBe(true)

        // Validate ledger replay
        expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
      } finally {
        await cleanup()
      }
    })

    it('fails for local agent with initial foreign channelRefs', async () => {
      const { ctx, cleanup } = await testHarness()
      try {
        const betaChannel = await ctx.agentTeam.createChannel({
          requestId: requestId('beta-chan-2'),
          workspaceId: beta,
          name: 'beta-general-2',
          description: 'Beta channel 2',
        })

        // Add Local Member in Alpha with initial channel in Beta -> MUST FAIL
        await expect(
          ctx.agentTeam.addMember({
            requestId: requestId('local-cross-chan-fail'),
            workspaceId: alpha,
            handle: 'local-cross-fail',
            description: 'Local worker',
            presetId: 'team-member',
            channelRefs: [betaChannel.channel.channelRef],
            isGlobal: false,
          })
        ).rejects.toThrow(/does not belong to Workspace/)

        // Also test with isGlobal undefined (default is local)
        await expect(
          ctx.agentTeam.addMember({
            requestId: requestId('local-default-cross-chan-fail'),
            workspaceId: alpha,
            handle: 'local-default-cross-fail',
            description: 'Local worker default',
            presetId: 'team-member',
            channelRefs: [betaChannel.channel.channelRef],
          })
        ).rejects.toThrow(/does not belong to Workspace/)
      } finally {
        await cleanup()
      }
    })

    it('fails for global agent if initial foreign channel is archived', async () => {
      const { ctx, cleanup } = await testHarness()
      try {
        const betaChannel = await ctx.agentTeam.createChannel({
          requestId: requestId('beta-chan-arch'),
          workspaceId: beta,
          name: 'beta-arch',
          description: 'Beta channel arch',
        })
        await ctx.agentTeam.archiveChannel({
          requestId: requestId('arch-beta-chan'),
          workspaceId: beta,
          channelRef: betaChannel.channel.channelRef,
        })

        // Attempt to create global agent with archived foreign channel -> MUST FAIL
        await expect(
          ctx.agentTeam.addMember({
            requestId: requestId('global-arch-channel'),
            workspaceId: alpha,
            handle: 'global-arch-tester',
            description: 'Global agent',
            presetId: 'team-member',
            channelRefs: [betaChannel.channel.channelRef],
            isGlobal: true,
          })
        ).rejects.toThrow(/is archived and no longer accepts Team work/)
      } finally {
        await cleanup()
      }
    })

    it('fails for global agent if initial foreign channel does not exist', async () => {
      const { ctx, cleanup } = await testHarness()
      try {
        await expect(
          ctx.agentTeam.addMember({
            requestId: requestId('global-nonexistent-channel'),
            workspaceId: alpha,
            handle: 'global-ghost-tester',
            description: 'Global agent',
            presetId: 'team-member',
            channelRefs: ['channel:nonexistent-channel' as any],
            isGlobal: true,
          })
        ).rejects.toThrow(/unknown Channel ref/)
      } finally {
        await cleanup()
      }
    })

    it('enforces idempotency collision when isGlobal varies on retry', async () => {
      const { ctx, cleanup } = await testHarness()
      try {
        const reqId = requestId('idempotent-global-req')
        await ctx.agentTeam.addMember({
          requestId: reqId,
          workspaceId: alpha,
          handle: 'global-idemp',
          description: 'Global agent',
          presetId: 'team-member',
          channelRefs: [],
          isGlobal: true,
        })

        // Exact retry with isGlobal: true resolves identically
        const retry1 = await ctx.agentTeam.addMember({
          requestId: reqId,
          workspaceId: alpha,
          handle: 'global-idemp',
          description: 'Global agent',
          presetId: 'team-member',
          channelRefs: [],
          isGlobal: true,
        })
        expect(retry1.status.member.isGlobal).toBe(true)

        // Conflicting retry with isGlobal: false throws collision
        await expect(
          ctx.agentTeam.addMember({
            requestId: reqId,
            workspaceId: alpha,
            handle: 'global-idemp',
            description: 'Global agent',
            presetId: 'team-member',
            channelRefs: [],
            isGlobal: false,
          })
        ).rejects.toThrow(/was reused with a different operation or payload/)
      } finally {
        await cleanup()
      }
    })
  })

  describe('Requirement 2: non-task threads in channels cleanup and handling', () => {
    it('cleans up both task and non-task threads upon removeChannelMember and archiveChannel', async () => {
      const { ctx, cleanup } = await testHarness()
      try {
        // Create channel in Alpha
        const channelRes = await ctx.agentTeam.createChannel({
          requestId: requestId('chan-mixed-threads'),
          workspaceId: alpha,
          name: 'general-mixed-threads',
          description: 'General discussion and tasks',
        })
        const chanRef = channelRes.channel.channelRef

        // Add two members
        const memberRes1 = await ctx.agentTeam.addMember({
          requestId: requestId('add-chatty-1'),
          workspaceId: alpha,
          handle: 'chatty-1',
          description: 'Chatty agent 1',
          presetId: 'team-member',
          channelRefs: [chanRef],
          isGlobal: true,
        })
        const memberId1 = memberRes1.status.member.memberId

        const memberRes2 = await ctx.agentTeam.addMember({
          requestId: requestId('add-chatty-2'),
          workspaceId: alpha,
          handle: 'chatty-2',
          description: 'Chatty agent 2',
          presetId: 'team-member',
          channelRefs: [chanRef],
          isGlobal: false,
        })
        const memberId2 = memberRes2.status.member.memberId

        // 1) Send a non-task message in the channel (asTask: false)
        const nonTaskRes = await ctx.agentTeam.sendMessage({
          asTask: false,
          requestId: requestId('non-task-msg-1'),
          workspaceId: alpha,
          channelRef: chanRef,
          body: 'Hello non-task conversational thread!',
          recipients: [memberId1, memberId2],
        })
        expect(nonTaskRes.kind).toBe('committed')
        if (nonTaskRes.kind !== 'committed') throw new Error('expected committed')
        const nonTaskThreadRef = nonTaskRes.thread.threadRef

        // 2) Send a task message in the channel (asTask: true)
        const taskRes = await ctx.agentTeam.sendMessage({
          asTask: true,
          requestId: requestId('task-msg-1'),
          workspaceId: alpha,
          channelRef: chanRef,
          body: 'Do this task!',
          recipients: [memberId1],
        })
        expect(taskRes.kind).toBe('committed')
        if (taskRes.kind !== 'committed') throw new Error('expected committed')
        const taskThreadRef = taskRes.thread.threadRef

        // Verify both threads belong to chanRef
        const viewBefore = await ctx.agentTeam.view({ workspaceId: alpha })
        expect(viewBefore.threads.some(t => t.threadRef === nonTaskThreadRef)).toBe(true)
        expect(viewBefore.threads.some(t => t.threadRef === taskThreadRef)).toBe(true)

        // 3) Remove member 1 from channel: must clean up member 1's inbox for BOTH task and non-task threads
        const removeRes = await ctx.agentTeam.removeChannelMember({
          requestId: requestId('remove-chatty-1'),
          workspaceId: alpha,
          channelRef: chanRef,
          memberId: memberId1,
        })
        expect(removeRes.receipt).toBeDefined()

        // 4) Archive channel: must clean up inbox and attention for BOTH task and non-task threads
        const archiveRes = await ctx.agentTeam.archiveChannel({
          requestId: requestId('archive-mixed-chan'),
          workspaceId: alpha,
          channelRef: chanRef,
        })
        expect(archiveRes.receipt).toBeDefined()

        // 5) Ledger replay validation MUST succeed
        expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
      } finally {
        await cleanup()
      }
    })
  })
})
