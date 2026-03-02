#!/usr/bin/env node
/**
 * MCP Server — exposes tool collection for MCP clients.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createRegistry } from '../core/registry.js'
import { getAllTools } from '../tools/index.js'

const PROJECT_PATH = process.env.TARGET_PROJECT_PATH || ''

async function main() {
  const registry = createRegistry(PROJECT_PATH)

  const tools = getAllTools(PROJECT_PATH)
  registry.registerMany(tools)

  const stats = registry.getStats()
  console.error(`[MCP Server] Loaded ${stats.total} tools:`)
  for (const [cat, count] of Object.entries(stats.categories)) {
    console.error(`  - ${cat}: ${count}`)
  }

  // Create MCP server
  const server = new McpServer(
    {
      name: 'devops-bot',
      version: '2.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  // Register all tools
  const allTools = registry.getAll()
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        description: `[${tool.category}] ${tool.description}`,
        inputSchema: tool.schema,
      },
      async (args) => {
        try {
          const result = await registry.execute(tool.name, (args || {}) as Record<string, unknown>)
          return { content: [{ type: 'text', text: result }] }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
        }
      },
    )
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error('[MCP Server] Running on stdio')
}

main().catch((error) => {
  console.error('[MCP Server] Fatal error:', error)
  process.exit(1)
})
