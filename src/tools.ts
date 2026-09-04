import { createHash } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import {
  ALLOWED_MCP_TOOLS,
  MUTATING_CALL_OPERATIONS,
  READ_CALL_OPERATIONS,
} from './constants.js'

const ALLOWED_TOOL_SET = new Set<string>(ALLOWED_MCP_TOOLS)
const READ_OPERATION_SET = new Set<string>(READ_CALL_OPERATIONS)
const MUTATING_OPERATION_SET = new Set<string>(MUTATING_CALL_OPERATIONS)
const ALLOWED_OPERATION_SET = new Set<string>([...READ_CALL_OPERATIONS, ...MUTATING_CALL_OPERATIONS])
const RawCallToolResultSchema = z.record(z.string(), z.unknown())
const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/gu
const HASH_LENGTH = 12

export interface ToolBridgeOptions {
  serverName: string
  toolCallTimeoutMs: number
  registrationFailure: 'contain' | 'throw'
}

export type ToolDisposers = Map<string, () => void>

export type ToolPolicyDecision =
  | { kind: 'allow' }
  | { kind: 'ask'; reason: string }
  | { kind: 'deny'; reason: string }

export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

function argumentRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {}
}

function approvalLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim()
  return normalized === '' ? fallback : normalized.slice(0, 80)
}

export function classifyToolCall(rawName: string, args: unknown): ToolPolicyDecision {
  if (!ALLOWED_TOOL_SET.has(rawName)) return { kind: 'deny', reason: `Bytebase MCP 工具 ${rawName} 不在插件白名单中` }
  const input = argumentRecord(args)
  if (rawName === 'propose_database_change') {
    if (input.createRollout === true) {
      return {
        kind: 'deny',
        reason: '创建变更工单时禁止 createRollout=true；请先创建工单并等待人工审批，再单独创建 Rollout',
      }
    }
    const database = approvalLabel(input.database, '目标数据库')
    const title = approvalLabel(input.title, '未命名变更')
    return { kind: 'ask', reason: `允许在 Bytebase 为 ${database} 创建变更工单“${title}”吗？` }
  }
  if (rawName === 'call_api') {
    const operationId = input.operationId
    if (typeof operationId !== 'string' || operationId.length === 0) {
      return { kind: 'deny', reason: 'call_api 必须提供明确的 operationId' }
    }
    if (!ALLOWED_OPERATION_SET.has(operationId)) {
      return { kind: 'deny', reason: `Bytebase API ${operationId} 不在插件 operationId 白名单中` }
    }
    if (MUTATING_OPERATION_SET.has(operationId)) {
      return { kind: 'ask', reason: `允许执行 Bytebase 发布操作 ${operationId} 吗？` }
    }
  }
  return { kind: 'allow' }
}

export function installToolPolicy(ctx: Context, serverName: string): () => void {
  const publicToRaw = new Map(ALLOWED_MCP_TOOLS.map(raw => [publicToolName(serverName, raw), raw]))
  const disposePolicy = ctx.on('tools/pre-execute', async (exec, next) => {
    const rawName = publicToRaw.get(exec.name)
    if (rawName === undefined) return await next()
    const decision = classifyToolCall(rawName, exec.arguments)
    if (decision.kind === 'allow') return await next()
    return decision
  })
  const disposeGuard = ctx.tools.guard(exec => {
    const rawName = publicToRaw.get(exec.name)
    if (rawName === undefined) return undefined
    const decision = classifyToolCall(rawName, exec.arguments)
    return decision.kind === 'deny' ? decision.reason : undefined
  })
  return () => {
    disposePolicy()
    disposeGuard()
  }
}

function safeDescription(rawName: string, description: string): string {
  if (rawName === 'propose_database_change') {
    return `${description}\n\nDSH 安全策略：本工具会创建真实 Sheet、Plan 和 Issue，调用前需要人工批准；createRollout 必须为 false。`
  }
  if (rawName === 'call_api') {
    return `${description}\n\nDSH 安全策略：operationId 仅允许读取 Issue/Plan/Rollout/TaskRun，或经人工批准后创建 Rollout、运行任务。审批、拒绝、跳过、取消及其他 API 均会被客户端拒绝。`
  }
  return description
}

function extractText(content: JsonValue[], toolName: string): string {
  const lines: string[] = []
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      lines.push('[unsupported MCP content block]')
      continue
    }
    const block = value as Record<string, JsonValue>
    if (block.type === 'text' && typeof block.text === 'string') lines.push(block.text)
    else if (block.type === 'resource_link' && typeof block.name === 'string' && typeof block.uri === 'string') {
      lines.push(`Resource link: ${block.name} (${block.uri})`)
    } else lines.push(`[unsupported MCP content type: ${String(block.type ?? 'unknown')}]`)
  }
  return lines.length > 0 ? lines.join('\n') : `(${toolName} returned no model-visible content)`
}

function createDefinition(
  client: Client,
  rawName: string,
  description: string,
  parameters: Record<string, unknown>,
  taskRequired: boolean,
  options: ToolBridgeOptions,
): ToolDefinition {
  return {
    name: publicToolName(options.serverName, rawName),
    description: safeDescription(rawName, description),
    parameters,
    output: {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: {} },
          structuredContent: {},
        },
        required: ['content'],
        additionalProperties: false,
      },
      render(_args, value) {
        const result = value as { content: JsonValue[] }
        return [{ type: 'text', text: extractText(result.content, rawName) }]
      },
    },
    async execute(args: unknown, exec: ToolExecution) {
      if (taskRequired) throw new Error(`Bytebase MCP 工具 ${rawName} 要求当前桥接尚不支持的 task execution`)
      const policy = classifyToolCall(rawName, args)
      if (policy.kind === 'deny') throw new Error(policy.reason)
      const result = await client.request({
        method: 'tools/call',
        params: { name: rawName, arguments: argumentRecord(args) },
      }, RawCallToolResultSchema, {
        signal: exec.signal,
        timeout: options.toolCallTimeoutMs,
      })
      const content = Array.isArray(result.content)
        ? result.content as JsonValue[]
        : [{ type: 'text', text: 'toolResult' in result ? JSON.stringify(result.toolResult) : '(no output)' }]
      const text = extractText(content, rawName)
      if (result.isError === true) throw new Error(text)
      return {
        content,
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent as JsonValue }),
      }
    },
  }
}

export async function syncTools(
  client: Client,
  ctx: Context,
  options: ToolBridgeOptions,
  previous: ToolDisposers,
): Promise<ToolDisposers> {
  const definitions = new Map<string, ToolDefinition>()
  const discovered = new Set<string>()
  let cursor: string | undefined
  do {
    const response = await client.request(
      { method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) },
      ListToolsResultSchema,
    )
    for (const tool of response.tools) {
      if (!ALLOWED_TOOL_SET.has(tool.name)) continue
      if (discovered.has(tool.name)) throw new Error(`Bytebase MCP 重复发布工具 ${tool.name}`)
      discovered.add(tool.name)
      const publicName = publicToolName(options.serverName, tool.name)
      definitions.set(publicName, createDefinition(
        client,
        tool.name,
        tool.description ?? '',
        tool.inputSchema,
        tool.execution?.taskSupport === 'required',
        options,
      ))
    }
    cursor = response.nextCursor
  } while (cursor !== undefined && cursor !== '')

  for (const required of ALLOWED_MCP_TOOLS) {
    if (!discovered.has(required)) ctx.logger.warn(`bytebase-mcp: server did not publish expected tool ${required}`)
  }

  for (const dispose of previous.values()) dispose()
  const next = new Map<string, () => void>()
  try {
    for (const [publicName, definition] of definitions) next.set(publicName, ctx.tools.register(definition))
  } catch (error: unknown) {
    for (const dispose of next.values()) dispose()
    ctx.logger.error(`bytebase-mcp: tool registration failed; no tools registered: ${String(error)}`)
    if (options.registrationFailure === 'throw') throw error
    return new Map()
  }
  return next
}

export function allowedOperationIds(): readonly string[] {
  return [...READ_CALL_OPERATIONS, ...MUTATING_CALL_OPERATIONS]
}

export function isReadOperation(operationId: string): boolean {
  return READ_OPERATION_SET.has(operationId)
}
