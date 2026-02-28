/**
 * AI Executor — provider-agnostic task execution engine.
 *
 * Uses the AIProvider interface + MCP protocol to execute AI tasks.
 * Works with Anthropic, OpenAI, or any compatible provider.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFile } from 'node:fs/promises'
import type { AIContentBlock, AIMessage, AIProvider, AIToolDefinition } from '../providers/types.js'
import { retry } from '../infra/retry.js'
import { createLogger } from '../infra/logger.js'

const log = createLogger('executor')

interface MCPServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>
}

interface MCPClient {
  name: string
  client: Client
  transport: StdioClientTransport
  tools: AIToolDefinition[]
}

export interface AIExecutorOptions {
  provider: AIProvider
  model?: string
  maxTokens?: number
  maxIterations?: number
  maxContextTokens?: number
  maxToolResultLength?: number
  systemPrompt?: string
  onOutput?: (chunk: string) => void
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function estimateMessageTokens(messages: AIMessage[]): number {
  let total = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          total += estimateTokens(block.text)
        } else if (block.type === 'tool_result') {
          total += estimateTokens(block.content)
        } else {
          total += estimateTokens(JSON.stringify(block))
        }
      }
    }
  }
  return total
}

export class AIExecutor {
  private provider: AIProvider
  private model: string
  private maxTokens: number
  private maxIterations: number
  private maxContextTokens: number
  private maxToolResultLength: number
  private systemPrompt?: string
  private mcpClients: MCPClient[] = []
  private onOutput: (chunk: string) => void
  private consecutiveToolErrors = 0

  constructor(options: AIExecutorOptions) {
    this.provider = options.provider
    this.model = options.model || 'claude-opus-4-5-20251101'
    this.maxTokens = options.maxTokens || 16384
    this.maxIterations = options.maxIterations || 50
    this.maxContextTokens = options.maxContextTokens || 150000
    this.maxToolResultLength = options.maxToolResultLength || 50000
    this.systemPrompt = options.systemPrompt
    this.onOutput = options.onOutput || ((chunk) => process.stdout.write(chunk))
  }

  async connectMCPServers(configPath: string): Promise<void> {
    const configContent = await readFile(configPath, 'utf-8')
    const config: MCPConfig = JSON.parse(configContent)

    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      try {
        await this.connectMCPServer(name, serverConfig)
        log.info(`MCP connected to ${name}`)
      } catch (error) {
        log.error(`MCP failed to connect to ${name}`, {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private async connectMCPServer(name: string, config: MCPServerConfig): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>,
    })

    const client = new Client(
      { name: `ai-executor-${name}`, version: '1.0.0' },
      { capabilities: {} },
    )

    await client.connect(transport)

    const toolsResult = await client.listTools()
    const tools: AIToolDefinition[] = toolsResult.tools.map((tool) => ({
      name: `${name}__${tool.name}`,
      description: tool.description || '',
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }))

    this.mcpClients.push({ name, client, transport, tools })
  }

  private getAllTools(): AIToolDefinition[] {
    return this.mcpClients.flatMap((c) => c.tools)
  }

  private async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const [serverName, ...toolParts] = toolName.split('__')
    const actualToolName = toolParts.join('__')

    const mcpClient = this.mcpClients.find((c) => c.name === serverName)
    if (!mcpClient) {
      return `Error: MCP server "${serverName}" not found`
    }

    try {
      const result = await mcpClient.client.callTool({
        name: actualToolName,
        arguments: args,
      })

      if (Array.isArray(result.content)) {
        const text = result.content
          .map((c) => {
            if (c.type === 'text') return c.text
            return JSON.stringify(c)
          })
          .join('\n')
        this.consecutiveToolErrors = 0
        return text
      }
      this.consecutiveToolErrors = 0
      return String(result.content)
    } catch (error) {
      this.consecutiveToolErrors++
      const errMsg = error instanceof Error ? error.message : String(error)
      const sentArgs = JSON.stringify(args, null, 2).slice(0, 300)
      return [
        `Error calling tool ${actualToolName}: ${errMsg}`,
        `Arguments sent: ${sentArgs}`,
        'Please check that all required parameters are provided with correct types.',
        this.consecutiveToolErrors >= 3
          ? 'IMPORTANT: This tool has failed multiple times in a row. Try a different approach or break the operation into smaller steps.'
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    }
  }

  private log(message: string): void {
    this.onOutput(`${message}\n`)
  }

  private handleTruncatedToolCall(
    stopReason: string,
    assistantContent: AIContentBlock[],
    messages: AIMessage[],
  ): boolean {
    if (stopReason !== 'max_tokens') return false

    const toolUseBlocks = assistantContent.filter((b) => b.type === 'tool_use')
    if (toolUseBlocks.length === 0) return false

    this.log(
      '\n[Warning] Response truncated (max_tokens) during tool call — arguments may be incomplete.',
    )
    this.log('[Action] Asking AI to retry with smaller content.\n')

    messages.push({ role: 'assistant', content: assistantContent })

    const errorResults: AIContentBlock[] = toolUseBlocks.map((block) => {
      if (block.type !== 'tool_use') throw new Error('unreachable')
      return {
        type: 'tool_result' as const,
        toolUseId: block.id,
        content:
          'ERROR: Your previous response was truncated (max_tokens) while generating this tool call, ' +
          'so the arguments were incomplete and the call was NOT executed. ' +
          'Please retry with smaller content. If you need to write a large file, break it into ' +
          'smaller chunks using append mode, or write a minimal version first and then use edit_file.',
        isError: true,
      }
    })
    messages.push({ role: 'user', content: errorResults })

    return true
  }

  private truncateToolResult(result: string, toolName: string): string {
    if (result.length <= this.maxToolResultLength) {
      return result
    }

    const keepStart = Math.floor(this.maxToolResultLength * 0.7)
    const keepEnd = Math.floor(this.maxToolResultLength * 0.2)
    return (
      result.slice(0, keepStart) +
      `\n\n... [TRUNCATED: ${result.length - keepStart - keepEnd} characters removed from ${toolName} output] ...\n\n` +
      result.slice(-keepEnd)
    )
  }

  private manageContextWindow(messages: AIMessage[]): AIMessage[] {
    let estimatedTokens = estimateMessageTokens(messages)

    if (estimatedTokens <= this.maxContextTokens) {
      return messages
    }

    this.log(
      `\n[Context Management] Tokens: ${estimatedTokens} > ${this.maxContextTokens}, trimming...`,
    )

    const firstMessage = messages[0]
    const recentMessages = messages.slice(-10)

    const trimmedMessages = [firstMessage, ...recentMessages.filter((m) => m !== firstMessage)]
    estimatedTokens = estimateMessageTokens(trimmedMessages)

    if (estimatedTokens > this.maxContextTokens) {
      this.log(
        `[Context Management] Still over limit (${estimatedTokens}), truncating tool results...`,
      )

      for (const msg of trimmedMessages) {
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_result' && block.content.length > 10000) {
              ;(block as { content: string }).content =
                block.content.slice(0, 5000) +
                '\n... [CONTEXT TRUNCATED] ...\n' +
                block.content.slice(-2000)
            }
          }
        }
      }
    }

    const finalTokens = estimateMessageTokens(trimmedMessages)
    this.log(
      `[Context Management] After trimming: ${finalTokens} tokens, ${trimmedMessages.length} messages`,
    )

    return trimmedMessages
  }

  /**
   * Run one iteration of the AI loop: call provider, process response, execute tools.
   * Returns true if the task is complete (no more tool calls).
   */
  private async runIteration(
    messages: AIMessage[],
    tools: AIToolDefinition[],
    fullOutput: { value: string },
    label: string,
  ): Promise<boolean> {
    const response = await retry(
      () =>
        this.provider.createMessage({
          model: this.model,
          maxTokens: this.maxTokens,
          system: this.systemPrompt,
          tools: tools.length > 0 ? tools : undefined,
          messages,
        }),
      {
        maxAttempts: 3,
        baseDelayMs: 2000,
        onRetry: (err, attempt, delay) => {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn(`AI API retry ${label} ${attempt}`, { delay, error: msg })
          this.log(`\n[Retry] Attempt ${attempt}, waiting ${delay}ms...`)
        },
      },
    )

    const assistantContent: AIContentBlock[] = []
    let hasToolUse = false

    for (const block of response.content) {
      if (block.type === 'text') {
        this.log(block.text)
        fullOutput.value += `${block.text}\n`
        assistantContent.push({ type: 'text', text: block.text })
      } else if (block.type === 'tool_use') {
        hasToolUse = true
        this.log(`\n[Tool Call] ${block.name}`)
        this.log(`Input: ${JSON.stringify(block.input, null, 2).slice(0, 500)}`)
        assistantContent.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        })
      }
    }

    if (this.handleTruncatedToolCall(response.stopReason, assistantContent, messages)) {
      return false
    }

    messages.push({ role: 'assistant', content: assistantContent })

    if (!hasToolUse || response.stopReason === 'end_turn') {
      return true
    }

    // Execute tool calls
    const toolResults: AIContentBlock[] = []
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        let result = await this.callTool(block.name, block.input)
        result = this.truncateToolResult(result, block.name)

        this.log(`\n[Tool Result] ${block.name} (${result.length} chars)`)
        this.log(result.slice(0, 500) + (result.length > 500 ? '...(truncated in log)' : ''))
        fullOutput.value += `\n[Tool: ${block.name}]\n${result.slice(0, 2000)}${result.length > 2000 ? '...' : ''}\n`

        toolResults.push({
          type: 'tool_result',
          toolUseId: block.id,
          content: result,
        })
      }
    }

    if (this.consecutiveToolErrors >= 5) {
      this.log('\n[Warning] 5+ consecutive tool errors — forcing AI to reassess approach.\n')
      this.consecutiveToolErrors = 0
      messages.push({ role: 'user', content: toolResults })
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'IMPORTANT: Multiple consecutive tool calls have failed. ' +
              'Please stop and reassess your approach. Explain what you are trying to do, ' +
              'then try a simpler or different strategy.',
          },
        ],
      })
      return false
    }

    messages.push({ role: 'user', content: toolResults })
    return false
  }

  async execute(prompt: string): Promise<string> {
    const tools = this.getAllTools()
    const fullOutput = { value: '' }
    let iteration = 0
    let extensionCount = 0
    const maxExtensions = 3

    let messages: AIMessage[] = [{ role: 'user', content: prompt }]

    this.log(`\n${'='.repeat(60)}`)
    this.log(`Starting AI execution with ${tools.length} tools available`)
    this.log(`Model: ${this.model}`)
    this.log(`Max context: ${this.maxContextTokens} tokens`)
    this.log(`System prompt: ${this.systemPrompt ? `${this.systemPrompt.length} chars` : 'none'}`)
    this.log(`${'='.repeat(60)}\n`)

    while (iteration < this.maxIterations) {
      iteration++
      this.log(`\n--- Iteration ${iteration} ---\n`)

      messages = this.manageContextWindow(messages)

      try {
        const done = await this.runIteration(messages, tools, fullOutput, '')
        if (done) {
          this.log(`\n${'='.repeat(60)}`)
          this.log(`Task completed after ${iteration} iterations`)
          this.log(`${'='.repeat(60)}\n`)
          break
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        this.log(`\n[Error] ${errorMessage}`)
        fullOutput.value += `\n[Error] ${errorMessage}\n`

        if (errorMessage.includes('too long') || errorMessage.includes('maximum')) {
          log.warn('Token limit exceeded, aggressive trimming', { iteration })
          this.log('[Context Management] Token limit exceeded, aggressive trimming...')
          const firstMsg = messages[0]
          const lastMsgs = messages.slice(-4)
          messages = [firstMsg, ...lastMsgs.filter((m) => m !== firstMsg)]
          continue
        }

        throw error
      }
    }

    // Extension loop
    while (iteration >= this.maxIterations && extensionCount < maxExtensions) {
      extensionCount++
      this.log(
        `\n[Context Management] Reached max iterations (${this.maxIterations}), trimming context (extension ${extensionCount}/${maxExtensions})...`,
      )

      const firstMsg = messages[0]
      const recentCount = Math.max(4, 10 - extensionCount * 2)
      const lastMsgs = messages.slice(-recentCount)
      messages = [firstMsg, ...lastMsgs.filter((m) => m !== firstMsg)]

      const estimatedTokens = estimateMessageTokens(messages)
      this.log(
        `[Context Management] After trimming: ~${estimatedTokens} tokens, ${messages.length} messages`,
      )

      const bonusIterations = Math.floor(this.maxIterations / 2)
      iteration = this.maxIterations - bonusIterations
      this.log(`[Context Management] Granting ${bonusIterations} bonus iterations`)

      while (iteration < this.maxIterations) {
        iteration++
        this.log(`\n--- Iteration ${iteration} (extended) ---\n`)

        messages = this.manageContextWindow(messages)

        try {
          const done = await this.runIteration(messages, tools, fullOutput, '(ext)')
          if (done) {
            this.log(`\n${'='.repeat(60)}`)
            this.log(
              `Task completed after ${iteration} iterations (with ${extensionCount} extensions)`,
            )
            this.log(`${'='.repeat(60)}\n`)
            return fullOutput.value
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          this.log(`\n[Error] ${errorMessage}`)
          fullOutput.value += `\n[Error] ${errorMessage}\n`

          if (errorMessage.includes('too long') || errorMessage.includes('maximum')) {
            log.warn('Token limit exceeded (ext), aggressive trimming', { iteration })
            const firstMsg2 = messages[0]
            const lastMsgs2 = messages.slice(-4)
            messages = [firstMsg2, ...lastMsgs2.filter((m) => m !== firstMsg2)]
            continue
          }

          throw error
        }
      }
    }

    if (extensionCount >= maxExtensions) {
      log.warn(`Reached maximum extensions (${maxExtensions}), task may be incomplete`)
      this.log(`\n[Warning] Reached maximum extensions (${maxExtensions}), task may be incomplete`)
    }

    return fullOutput.value
  }

  async disconnect(): Promise<void> {
    for (const { name, client, transport } of this.mcpClients) {
      try {
        await client.close()
        await transport.close()
        log.debug(`MCP disconnected from ${name}`)
      } catch {
        // Ignore disconnect errors
      }
    }
    this.mcpClients = []
  }
}
