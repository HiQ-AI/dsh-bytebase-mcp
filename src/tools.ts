import { createHash } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

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
    description,
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
