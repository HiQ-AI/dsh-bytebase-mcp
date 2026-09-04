import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ALLOWED_MCP_TOOLS } from '../src/constants.js'
import {
  allowedOperationIds,
  classifyToolCall,
  installToolPolicy,
  publicToolName,
  syncTools,
} from '../src/tools.js'

describe('Bytebase tool policy', () => {
  it('requires approval for issue creation and forbids coupled rollout creation', () => {
    expect(classifyToolCall('propose_database_change', {
      database: 'hiq_lcd',
      title: '回填数据',
      createRollout: false,
    }).kind).toBe('ask')
    expect(classifyToolCall('propose_database_change', {
      database: 'hiq_lcd',
      title: '回填数据',
      createRollout: true,
    })).toMatchObject({ kind: 'deny' })
  })

  it('allows only fixed call_api operation IDs', () => {
    expect(classifyToolCall('call_api', {
      operationId: 'bytebase.v1.IssueService.GetIssue',
    })).toEqual({ kind: 'allow' })
    expect(classifyToolCall('call_api', {
      operationId: 'bytebase.v1.RolloutService.CreateRollout',
    }).kind).toBe('ask')
    expect(classifyToolCall('call_api', {
      operationId: 'bytebase.v1.IssueService.ApproveIssue',
    })).toMatchObject({ kind: 'deny' })
    expect(allowedOperationIds()).not.toContain('bytebase.v1.IssueService.ApproveIssue')
  })

  it('asks through the DSH approval waterfall for mutating tools', async () => {
    let listener: ((exec: { name: string; arguments: unknown }, next: () => Promise<{ kind: 'allow' }>) => Promise<unknown>) | undefined
    const ctx = {
      on: vi.fn((_name, registered) => {
        listener = registered
        return () => true
      }),
      tools: { guard: vi.fn(() => () => undefined) },
    } as unknown as Context
    installToolPolicy(ctx, 'bytebase')
    const result = await listener?.({
      name: publicToolName('bytebase', 'propose_database_change'),
      arguments: { database: 'hiq_lcd', title: '回填数据' },
    }, async () => ({ kind: 'allow' }))
    expect(result).toMatchObject({ kind: 'ask' })
  })

  it('registers only the fixed MCP tool allowlist', async () => {
    const registered: string[] = []
    const client = {
      request: vi.fn(async (request: { method: string }) => {
        if (request.method !== 'tools/list') throw new Error('unexpected request')
        return {
          tools: [
            ...ALLOWED_MCP_TOOLS.map(name => ({ name, description: name, inputSchema: { type: 'object' } })),
            { name: 'future_dangerous_tool', description: 'danger', inputSchema: { type: 'object' } },
          ],
        }
      }),
    } as unknown as Client
    const ctx = {
      logger: { warn: vi.fn(), error: vi.fn() },
      tools: {
        register(definition: { name: string }) {
          registered.push(definition.name)
          return () => undefined
        },
      },
    } as unknown as Context
    await syncTools(client, ctx, {
      serverName: 'bytebase',
      toolCallTimeoutMs: 60_000,
      registrationFailure: 'throw',
    }, new Map())
    expect(registered.sort()).toEqual(ALLOWED_MCP_TOOLS.map(name => publicToolName('bytebase', name)).sort())
    expect(registered.some(name => name.includes('future_dangerous_tool'))).toBe(false)
  })

  it('is denied by the real DSH ToolRuntime before a mutation reaches MCP when approval is unavailable', async () => {
    const ctx = new Context()
    const systemPrompt = ctx.plugin(SystemPrompt)
    await systemPrompt
    const toolRuntime = ctx.plugin(ToolRuntime)
    await toolRuntime
    const request = vi.fn(async (input: { method: string }) => {
      if (input.method === 'tools/list') {
        return {
          tools: [{
            name: 'propose_database_change',
            description: 'create issue',
            inputSchema: {
              type: 'object',
              properties: { database: { type: 'string' }, title: { type: 'string' } },
              required: ['database', 'title'],
            },
          }],
        }
      }
      throw new Error('mutation reached MCP unexpectedly')
    })
    const client = { request } as unknown as Client
    installToolPolicy(ctx, 'bytebase')
    await syncTools(client, ctx, {
      serverName: 'bytebase',
      toolCallTimeoutMs: 60_000,
      registrationFailure: 'throw',
    }, new Map())
    const result = await ctx.tools.execute({
      callId: 'fixture-call' as never,
      name: publicToolName('bytebase', 'propose_database_change'),
      arguments: { database: 'hiq_lcd', title: '回填数据' },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    await toolRuntime.dispose()
    await systemPrompt.dispose()
  })
})
