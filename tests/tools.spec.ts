import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { publicToolName, syncTools } from '../src/tools.js'

describe('Bytebase tool bridge', () => {
  it('registers every tool advertised by the MCP server', async () => {
    const rawNames = ['query_database', 'propose_database_change', 'future_server_tool']
    const registered: string[] = []
    const client = {
      request: vi.fn(async (request: { method: string }) => {
        if (request.method !== 'tools/list') throw new Error('unexpected request')
        return {
          tools: rawNames.map(name => ({ name, description: name, inputSchema: { type: 'object' } })),
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

    expect(registered.sort()).toEqual(rawNames.map(name => publicToolName('bytebase', name)).sort())
  })

  it('forwards mutating tools without a client-side allowlist or approval gate', async () => {
    const ctx = new Context()
    const systemPrompt = ctx.plugin(SystemPrompt)
    await systemPrompt
    const toolRuntime = ctx.plugin(ToolRuntime)
    await toolRuntime
    const request = vi.fn(async (input: { method: string }) => {
      if (input.method === 'tools/list') {
        return {
          tools: ['propose_database_change', 'call_api'].map(name => ({
            name,
            description: `server-authorized ${name}`,
            inputSchema: { type: 'object' },
          })),
        }
      }
      if (input.method === 'tools/call') return { content: [{ type: 'text', text: 'forwarded' }] }
      throw new Error('unexpected request')
    })
    const client = { request } as unknown as Client
    await syncTools(client, ctx, {
      serverName: 'bytebase',
      toolCallTimeoutMs: 60_000,
      registrationFailure: 'throw',
    }, new Map())

    const proposalArguments = {
      database: 'fixture',
      sql: 'UPDATE example SET value = 1',
      title: 'fixture change',
      createRollout: true,
    }
    const proposalResult = await ctx.tools.execute({
      callId: 'proposal-call' as never,
      name: publicToolName('bytebase', 'propose_database_change'),
      arguments: proposalArguments,
      signal: new AbortController().signal,
    })
    const apiArguments = { operationId: 'IssueService/ApproveIssue', body: { name: 'issues/fixture' } }
    const apiResult = await ctx.tools.execute({
      callId: 'fixture-call' as never,
      name: publicToolName('bytebase', 'call_api'),
      arguments: apiArguments,
      signal: new AbortController().signal,
    })

    expect(proposalResult.isError).toBe(false)
    expect(apiResult.isError).toBe(false)
    expect(request).toHaveBeenCalledWith({
      method: 'tools/call',
      params: { name: 'propose_database_change', arguments: proposalArguments },
    }, expect.anything(), expect.objectContaining({ timeout: 60_000 }))
    expect(request).toHaveBeenCalledWith({
      method: 'tools/call',
      params: { name: 'call_api', arguments: apiArguments },
    }, expect.anything(), expect.objectContaining({ timeout: 60_000 }))
    await toolRuntime.dispose()
    await systemPrompt.dispose()
  })
})
