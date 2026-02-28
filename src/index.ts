#!/usr/bin/env node
/**
 * DevOps Bot CLI
 *
 * AI-driven automation for bug fixing and feature development.
 * Uses Claude API with MCP tools to analyze and implement changes.
 * Feishu bot (WebSocket) is the primary user interface.
 *
 * Usage:
 *   devops-bot              # Start server (default)
 *   devops-bot start        # Start server
 *   devops-bot --help       # Show help
 */

import dotenv from 'dotenv'
dotenv.config({ path: ['.env.local', '.env'] })

const VERSION = '2.0.0'

interface CLIOptions {
  port?: number
  project?: string
  help?: boolean
  version?: boolean
}

function parseArgs(args: string[]): { command: string; options: CLIOptions } {
  const options: CLIOptions = {}
  let command = 'start' // 默认命令

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '-h' || arg === '--help') {
      options.help = true
    } else if (arg === '-v' || arg === '--version') {
      options.version = true
    } else if (arg === '-p' || arg === '--port') {
      options.port = parseInt(args[++i], 10)
    } else if (arg === '--project') {
      options.project = args[++i]
    } else if (!arg.startsWith('-')) {
      command = arg
    }
  }

  return { command, options }
}

function printVersion() {
  console.log(`devops-bot v${VERSION}`)
}

function printHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    DevOps Bot                        ║
║         AI-driven automation powered by Claude API            ║
║         Feishu bot as primary interface (WebSocket)           ║
╚══════════════════════════════════════════════════════════════╝

Usage:
  devops-bot [command] [options]

Commands:
  start            Start the DevOps server (default)
  mcp              Start MCP Server only (stdio mode)
  tools            List all available MCP tools
  migrate-tasks    Import existing tasks.json into memory system
  setup-embedding  Install local embedding model for vector search
  upgrade          Upgrade to the latest version

Options:
  -p, --port <port>       Server port (default: 3200)
  --project <path>        Target project path
  -h, --help              Show this help message
  -v, --version           Show version

Environment Variables:
  AI_PROVIDER             AI provider: anthropic | openai (default: anthropic)
  AI_API_KEY              AI API key (required)
  AI_BASE_URL             Custom base URL (for OpenAI-compatible endpoints)
  TASK_MODEL              Task AI model (default: claude-opus-4-5-20251101)
  DISPATCHER_MODEL        Dispatcher model (default: claude-sonnet-4-5-20250929)
  TARGET_PROJECT_PATH     Target project path
  WEBHOOK_PORT            Server port (default: 3200)
  IM_PLATFORM             IM platform: feishu | slack (default: feishu)
  FEISHU_APP_ID           Feishu bot App ID
  FEISHU_APP_SECRET       Feishu bot App Secret
  SLACK_BOT_TOKEN         Slack bot token
  SLACK_APP_TOKEN         Slack app token (for Socket Mode)

Examples:
  # Start server (Feishu bot connects automatically)
  devops-bot

  # Start on custom port
  devops-bot start -p 8080

  # Start with specific project
  devops-bot --project /path/to/project

  # List available tools
  devops-bot tools

Configuration:
  1. Copy .env.example to .env.local
  2. Set AI_API_KEY
  3. Set TARGET_PROJECT_PATH
  4. Configure an IM platform (Feishu or Slack)
  5. Run 'devops-bot'

IM Platforms:
  Feishu: WebSocket mode, no public IP needed
  Slack:  Socket Mode, no public URL needed
`)
}

async function startServer(options: CLIOptions) {
  const aiApiKey = process.env.AI_API_KEY
  if (!aiApiKey) {
    console.error('❌ Error: AI_API_KEY is not set')
    console.error('   Set it in .env.local')
    process.exit(1)
  }

  const { WebhookServer } = await import('./webhook/server.js')

  const config = {
    port: options.port || parseInt(process.env.WEBHOOK_PORT || '3200', 10),
    secret: process.env.WEBHOOK_SECRET || 'dev-secret',
    projectPath: options.project || process.env.TARGET_PROJECT_PATH || process.cwd(),
  }

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    DevOps Bot                               ║
╚══════════════════════════════════════════════════════════════╝
`)
  const aiProvider = process.env.AI_PROVIDER || 'anthropic'
  const taskModel = process.env.TASK_MODEL || 'claude-opus-4-5-20251101'
  const imPlatform = process.env.IM_PLATFORM || 'feishu'

  console.log(`📁 Project:  ${config.projectPath}`)
  console.log(`🔑 API Key:  ${aiApiKey.slice(0, 10)}...`)
  console.log(`🤖 Provider: ${aiProvider}`)
  console.log(`🤖 Task AI:  ${taskModel}`)
  console.log(`🧠 Router:   ${process.env.DISPATCHER_MODEL || 'claude-sonnet-4-5-20250929'}`)
  console.log(`💬 IM:       ${imPlatform}`)
  console.log('')

  const server = new WebhookServer(config)
  await server.start()

  // Pre-warm memory store (triggers JSONL→SQLite migration on first upgrade)
  const { getMemoryStore } = await import('./memory/store.js')
  await getMemoryStore()

  // Start IM platform
  try {
    const { createPlatform } = await import('./channels/index.js')
    const { Dispatcher } = await import('./dispatcher/index.js')

    const platform = await createPlatform()
    const dispatcher = new Dispatcher(platform, server)

    server.setIMPlatform(platform)

    await platform.connect({
      onMessage: (msg) => dispatcher.dispatch(msg),
      onPassiveMessage: (msg) => dispatcher.recordMessage(msg),
    })
    console.log(`[IM] ${imPlatform} platform connected`)
  } catch (err: any) {
    if (
      err.message?.includes('required') &&
      (err.message?.includes('FEISHU') || err.message?.includes('SLACK'))
    ) {
      console.log(`[IM] Skipped (${imPlatform} credentials not configured)`)
    } else {
      console.error(`[IM] Failed to start ${imPlatform} platform:`, err.message || err)
    }
  }
}

async function startMCP() {
  await import('./mcp/server.js')
}

async function listTools() {
  const { createRegistry } = await import('./core/registry.js')
  const { getAllTools } = await import('./tools/index.js')

  const projectPath = process.env.TARGET_PROJECT_PATH || process.cwd()
  const registry = createRegistry(projectPath)

  const tools = getAllTools(projectPath)
  registry.registerMany(tools)

  const stats = registry.getStats()

  console.log('\n📦 Available MCP Tools\n')

  for (const [category, count] of Object.entries(stats.categories)) {
    console.log(`\n[${category.toUpperCase()}] (${count})`)
    const catTools = registry.getByCategory(category)
    for (const tool of catTools) {
      console.log(`  • ${tool.name}`)
      console.log(`    ${tool.description}`)
    }
  }

  console.log(`\nTotal: ${stats.total} tools\n`)
}

async function migrateTasks() {
  const { readFile } = await import('node:fs/promises')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { getMemoryStore } = await import('./memory/store.js')
  const { MemoryExtractor } = await import('./memory/extractor.js')

  const __dir = dirname(fileURLToPath(import.meta.url))
  const tasksPath = join(__dir, '..', 'data', 'tasks.json')
  const projectPath = process.env.TARGET_PROJECT_PATH || process.cwd()

  console.log('📦 Migrating tasks.json into memory system...\n')
  console.log(`   Tasks file:  ${tasksPath}`)
  console.log(`   Project:     ${projectPath}\n`)

  // Load tasks.json
  let tasks: Array<Record<string, any>>
  try {
    const raw = await readFile(tasksPath, 'utf-8')
    tasks = JSON.parse(raw)
  } catch (err) {
    console.error('❌ Failed to read tasks.json:', (err as Error).message)
    process.exit(1)
  }

  // Initialize memory store
  const store = await getMemoryStore()
  const extractor = new MemoryExtractor(store)

  // Check what's already imported to avoid duplicates
  const existingInputs = new Set(
    store.getItemsByType('task_input', projectPath).map((i) => i.sourceId),
  )
  const existingResults = new Set(
    store.getItemsByType('task_result', projectPath).map((i) => i.sourceId),
  )

  let importedInputs = 0
  let importedResults = 0
  let importedFailures = 0
  let skipped = 0

  for (const task of tasks) {
    const id = task.id as string
    if (!id) continue

    // Extract title and description from task metadata / prompt
    const title = (task.metadata?.title as string) || task.prompt?.slice(0, 100) || id
    const descMatch = (task.prompt as string)?.match(
      /\*\*Description:\*\*\n([\s\S]*?)(?:\n\s*(?:## Attachments|#{2,}|-{3,})|$)/,
    )
    const description = descMatch?.[1]?.trim() || ''
    const fullInput = description ? `${title}\n${description}` : title

    // Import task input
    if (!existingInputs.has(id)) {
      extractor.memorizeTaskInput(
        {
          id,
          prompt: fullInput,
          createdBy: (task.createdBy as string) || 'unknown',
          status: task.status,
          output: '',
          createdAt: task.createdAt,
        },
        projectPath,
      )
      importedInputs++
    } else {
      skipped++
    }

    // Import task result (completed tasks with summary)
    if (task.status === 'completed' && task.summary && !existingResults.has(id)) {
      const summary = task.summary as { modifiedFiles?: string[]; thinking?: string }
      store.addItem({
        type: 'task_result',
        content: [
          summary.thinking || '',
          summary.modifiedFiles?.length
            ? `Modified files: ${summary.modifiedFiles.join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
        source: 'task',
        sourceId: id,
        projectPath,
        createdBy: (task.createdBy as string) || 'unknown',
      })
      importedResults++
    }

    // Import failures
    if (task.status === 'failed' && task.error && !existingResults.has(id)) {
      store.addItem({
        type: 'issue',
        content: `Task "${title}" failed: ${task.error}`,
        source: 'task',
        sourceId: id,
        projectPath,
        createdBy: (task.createdBy as string) || 'unknown',
      })
      importedFailures++
    }
  }

  // Flush conversations and export JSONL
  await store.close()

  console.log(`✅ Migration complete:`)
  console.log(`   📥 Task inputs:  ${importedInputs}`)
  console.log(`   📤 Task results: ${importedResults}`)
  console.log(`   ❌ Failures:     ${importedFailures}`)
  if (skipped > 0) {
    console.log(`   ⏭️  Skipped:      ${skipped} (already imported)`)
  }
  console.log(`\n   Total tasks processed: ${tasks.length}`)
}

/* ------------------------------------------------------------------ */
/*  setup-embedding — install node-llama-cpp + pre-download model      */
/* ------------------------------------------------------------------ */

async function setupEmbedding() {
  const { execSync } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')

  const __dirname = dirname(fileURLToPath(import.meta.url))
  const rootDir = join(__dirname, '..')
  const modelsDir = join(rootDir, 'models')
  const pm = process.env.BUN_INSTALL ? 'bun' : 'pnpm'

  console.log('🧠 Setting up local embedding model...\n')
  console.log('   Model:  embeddinggemma-300M (768 dims, ~300MB)')
  console.log('   Engine: node-llama-cpp (runs locally, no API cost)\n')

  // Step 1: ensure node-llama-cpp is installed
  const pkgDir = join(rootDir, 'node_modules', 'node-llama-cpp')
  let needsInstall = !existsSync(pkgDir)

  // Also verify import works (package dir might exist but be broken)
  if (!needsInstall) {
    try {
      await import('node-llama-cpp')
    } catch {
      needsInstall = true
    }
  }

  if (needsInstall) {
    console.log('📦 Installing node-llama-cpp...')
    try {
      // Use --force to ensure actual installation (avoid peerDep shortcut)
      execSync(`${pm} add node-llama-cpp`, { cwd: rootDir, stdio: 'inherit' })
      console.log('')
    } catch (err) {
      console.error('❌ Failed to install node-llama-cpp:', (err as Error).message)
      console.error('   You can install it manually: pnpm add node-llama-cpp')
      process.exit(1)
    }

    // Verify installation succeeded
    if (!existsSync(pkgDir)) {
      console.error('❌ node-llama-cpp package directory not found after install')
      console.error(`   Expected at: ${pkgDir}`)
      console.error('   Try manually: cd ~/.devops-bot && bun add node-llama-cpp')
      process.exit(1)
    }

    // Verify import works
    try {
      await import('node-llama-cpp')
      console.log('   ✓ node-llama-cpp import verified')
    } catch (err) {
      console.warn(`   ⚠️  node-llama-cpp installed but import failed: ${(err as Error).message}`)
      console.warn('   Embedding may not work at runtime — consider using OPENAI_API_KEY fallback')
    }
  } else {
    console.log('✓ node-llama-cpp already installed')
  }

  // Step 2: pre-download the embedding model via node-llama-cpp pull
  console.log('\n📥 Downloading embedding model...')
  console.log('   (this may take a few minutes on first run)\n')
  try {
    execSync(
      `npx --yes node-llama-cpp pull --dir "${modelsDir}" "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf"`,
      { cwd: rootDir, stdio: 'inherit' },
    )
    console.log('')
  } catch {
    // node-llama-cpp pull may not be available, try resolveModelFile approach
    console.log('   CLI pull unavailable, will download on first use via resolveModelFile')
    console.log('   Triggering download now...\n')
    try {
      const { getLlama, LlamaLogLevel, resolveModelFile } = await import('node-llama-cpp')
      const modelPath = await resolveModelFile(
        'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf',
        modelsDir,
      )
      // Quick validation: load the model
      const llama = await getLlama({ logLevel: LlamaLogLevel.error })
      const model = await llama.loadModel({ modelPath })
      const ctx = await model.createEmbeddingContext()
      const result = await ctx.getEmbeddingFor('test')
      console.log(`   ✓ Model verified (${result.vector.length} dimensions)`)
      await model.dispose?.()
    } catch (err) {
      console.error('❌ Model download failed:', (err as Error).message)
      console.error('   The model will attempt to download on first use')
    }
  }

  console.log('✅ Embedding setup complete!\n')
  console.log('   Memory search now uses:')
  console.log('   • Vector search (semantic similarity)')
  console.log('   • Keyword search (BM25)')
  console.log('   • Salience ranking (reinforcement + recency)\n')
  console.log('   Restart with: devops-bot start')
}

/**
 * Check whether node-llama-cpp is installed (non-blocking).
 * Used by upgrade to auto-update the model.
 */
async function isLlamaInstalled(): Promise<boolean> {
  try {
    await import('node-llama-cpp')
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/*  upgrade                                                            */
/* ------------------------------------------------------------------ */

/**
 * Check whether the user has downloaded embedding model files.
 * Model files in models/ survive upgrades, so they serve as a
 * persistent marker that the user opted into local embeddings.
 */
async function hasEmbeddingModel(rootDir: string): Promise<boolean> {
  const { existsSync, readdirSync } = await import('node:fs')
  const modelsDir = rootDir + '/models'
  if (!existsSync(modelsDir)) return false
  try {
    const entries = readdirSync(modelsDir)
    return entries.length > 0
  } catch {
    return false
  }
}

async function upgrade() {
  const { execSync } = await import('node:child_process')
  const { dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')

  const __dirname = dirname(fileURLToPath(import.meta.url))
  const rootDir = __dirname + '/..'

  console.log('🔄 Upgrading DevOps Bot...\n')

  try {
    const hadEmbedding = (await hasEmbeddingModel(rootDir)) || (await isLlamaInstalled())

    const installScript = rootDir + '/install.sh'
    const { existsSync } = await import('node:fs')

    if (existsSync(installScript)) {
      console.log('📥 Running install script...')
      execSync(`bash "${installScript}"`, { cwd: rootDir, stdio: 'inherit' })
    } else {
      const repo = process.env.DEVOPS_BOT_REPO || 'xxxxxccc/devops-bot'
      console.log('📥 Downloading latest install script...')
      execSync(`curl -fsSL "https://raw.githubusercontent.com/${repo}/main/install.sh" | bash`, {
        stdio: 'inherit',
      })
    }

    if (hadEmbedding) {
      console.log('\n🧠 Re-installing embedding support...')
      await setupEmbedding()
    }

    console.log('\n✅ Upgrade complete! Restart with: devops-bot start')
  } catch (error) {
    console.error('\n❌ Upgrade failed:', (error as Error).message)
    process.exit(1)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const { command, options } = parseArgs(args)

  if (options.version) {
    printVersion()
    process.exit(0)
  }

  if (options.help) {
    printHelp()
    process.exit(0)
  }

  switch (command) {
    case 'start':
    case 'server':
    case 'webhook':
      await startServer(options)
      break

    case 'mcp':
      await startMCP()
      break

    case 'tools':
      await listTools()
      break

    case 'migrate-tasks':
      await migrateTasks()
      break

    case 'setup-embedding':
      await setupEmbedding()
      break

    case 'upgrade':
      await upgrade()
      break

    case 'help':
      printHelp()
      break

    default:
      console.error(`Unknown command: ${command}`)
      printHelp()
      process.exit(1)
  }
}

main().catch((error) => {
  console.error('❌ Error:', error.message)
  process.exit(1)
})
