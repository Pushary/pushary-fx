#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCHEMA_VERSION = 1
export const DEFAULT_GATED_TOOLS = Object.freeze(['terminal', 'delete_file', 'rename_file'])
export const RUNNING_TERMINAL_ACTIONS = new Set(['exec', 'start', 'write'])
export const DEFAULT_WAIT_MS = 50_000
export const MIN_WAIT_MS = 5_000
export const MAX_WAIT_MS = 58_000
export const WITHDRAW_TIMEOUT_MS = 2_000
const ASK_TIMEOUT_CAP_MS = 55_000
const RESPONSE_MARGIN_MS = 3_000
const NOTIFY_TIMEOUT_MS = 5_000
const DEFAULT_BASE_URL = 'https://pushary.com'
const MCP_PATH = '/api/mcp/mcp'
const QUESTION_MAX = 500
const ACTION_MAX = 500
const ACTION_BODY_MAX = 4_000
const TOOL_TARGET_MAX = 80
const AGENT_NAME_MAX = 100
const SESSION_ID_MAX = 128
const TOOL_USE_ID_MAX = 200
const TEST_ENV = 'test'

export const CONTINUE = Object.freeze({ action: 'continue' })
export const ALLOW_STOP = Object.freeze({ action: 'allow' })
export const DENIED_REASON = 'The user denied this tool call from their phone through Pushary.'
export const UNANSWERED_REASON = "The user did not answer on their phone through Pushary. Ask them in the terminal before trying again."
export const UNANSWERED_POLICIES = new Set(['continue', 'block'])

export const ATTENTION_MESSAGES = Object.freeze({
  permission: 'fx is waiting for you to approve a tool call in the terminal.',
  question: 'fx asked you a question in the terminal.',
  route_recovery: 'fx needs you to choose how to recover its model route.',
})

const SECRET_PATTERNS = [
  [/-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted key]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]'],
  [/\b[spr]k_(?:live|test)_[A-Za-z0-9]{8,}\b/g, '[redacted]'],
  [/\bpk_[A-Za-z0-9]{8,}\.[A-Za-z0-9]{8,}\b/g, '[redacted]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '[redacted]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[redacted]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted]'],
  [/\bAIza[A-Za-z0-9_-]{35}\b/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'bearer [redacted]'],
  [/\bauthorization:\s*\S+/gi, 'authorization: [redacted]'],
  [/((?:secret|token|password|passwd|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]'],
]
const HIGH_ENTROPY_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const stringOf = value => (typeof value === 'string' ? value : '')
const truncate = (value, max) => (value.length <= max ? value : `${value.slice(0, max - 1)}…`)
const oneLine = value => value.replace(/\s+/g, ' ').trim()
const block = reason => ({ action: 'block', reason })

export const redactSecrets = text => SECRET_PATTERNS.reduce((redacted, [pattern, replacement]) => redacted.replace(pattern, replacement), text)

export const redactActionBody = text => redactSecrets(text).replace(HIGH_ENTROPY_RUN, '[redacted]')

export const parseEnvelope = raw => {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value) || value.schema_version !== SCHEMA_VERSION || typeof value.event !== 'string') return null
  return isRecord(value.invocation) && isRecord(value.payload) ? value : null
}

const clampWaitMs = value => Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, value))

export const parseOptions = argv => {
  const options = { waitMs: DEFAULT_WAIT_MS, unanswered: 'continue', gatedTools: new Set(DEFAULT_GATED_TOOLS) }
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value = ''] = [argv[index], argv[index + 1]]
    if (flag === '--wait-ms' && /^\d+$/.test(value)) options.waitMs = clampWaitMs(Number(value))
    if (flag === '--unanswered' && UNANSWERED_POLICIES.has(value)) options.unanswered = value
    if (flag === '--gate') options.gatedTools = new Set(value.split(',').map(name => name.trim()).filter(Boolean))
  }
  return options
}

export const needsApproval = (toolName, args, gatedTools) =>
  gatedTools.has(toolName) && (toolName !== 'terminal' || RUNNING_TERMINAL_ACTIONS.has(stringOf(args.action)))

const SUBCOMMAND = /^[a-z][a-z0-9:-]*$/

export const commandHead = command => {
  const [program = '', second = ''] = oneLine(command).split(' ')
  return SUBCOMMAND.test(second) ? `${program} ${second}` : program
}

const describeTerminal = args => {
  const command = stringOf(args.command) || JSON.stringify(args)
  return { question: `Allow fx to run: ${oneLine(command)}`, target: commandHead(command), body: command }
}

const describePathChange = (verb, path, detail) => ({
  question: `Allow fx to ${verb} ${detail}`,
  target: extname(path) || basename(path),
  body: detail,
})

export const describeToolCall = (toolName, args) => {
  if (toolName === 'terminal') return describeTerminal(args)
  if (toolName === 'rename_file') {
    const from = stringOf(args.old_path)
    return describePathChange('rename', from, `${from} to ${stringOf(args.new_path)}`)
  }
  if (toolName === 'copy_file') {
    const source = stringOf(args.source)
    return describePathChange('copy', source, `${source} to ${stringOf(args.destination) || stringOf(args.dest)}`)
  }
  const path = stringOf(args.path)
  const verbs = { delete_file: 'delete', write_file: 'write', edit_file: 'edit', create_folder: 'create' }
  return describePathChange(verbs[toolName] ?? `use ${toolName} on`, path, path || JSON.stringify(args))
}

export const agentNameFor = workspaceRoot =>
  truncate(`fx - ${basename(stringOf(workspaceRoot)) || 'workspace'}`, AGENT_NAME_MAX)

export const askArgumentsFor = (envelope, askTimeoutMs, env) => {
  const { tool_name: toolName, arguments: rawArgs, call_id: callId } = envelope.payload
  const args = isRecord(rawArgs) ? rawArgs : {}
  const call = describeToolCall(stringOf(toolName), args)
  const sessionId = stringOf(envelope.invocation.session_id)
  const redactedQuestion = oneLine(redactSecrets(call.question))
  return {
    question: truncate(redactedQuestion, QUESTION_MAX),
    type: 'confirm',
    wait: true,
    timeoutMs: askTimeoutMs,
    agentName: agentNameFor(envelope.invocation.workspace_root),
    toolName: truncate(stringOf(toolName), TOOL_TARGET_MAX),
    toolTarget: truncate(oneLine(redactSecrets(call.target)), TOOL_TARGET_MAX),
    action: truncate(redactedQuestion, ACTION_MAX),
    actionBody: truncate(redactActionBody(call.body), ACTION_BODY_MAX),
    ...(sessionId ? { sessionId: truncate(sessionId, SESSION_ID_MAX) } : {}),
    ...(stringOf(callId) ? { toolUseId: truncate(stringOf(callId), TOOL_USE_ID_MAX) } : {}),
    ...(env === TEST_ENV ? { env: TEST_ENV } : {}),
  }
}

export const decisionForAnswer = (answer, unanswered) => {
  if (isRecord(answer) && answer.answered === true && answer.value === 'yes') return CONTINUE
  if (isRecord(answer) && answer.answered === true && answer.value === 'no') return block(DENIED_REASON)
  return unanswered === 'block' ? block(UNANSWERED_REASON) : CONTINUE
}

const fallbackDecision = unanswered => decisionForAnswer(null, unanswered)

export const askTimeoutFor = waitMs => Math.min(ASK_TIMEOUT_CAP_MS, waitMs - RESPONSE_MARGIN_MS)

export const resolveApiKey = (env, home) => {
  const fromEnv = stringOf(env.PUSHARY_API_KEY).trim()
  if (fromEnv) return fromEnv
  try {
    const config = JSON.parse(readFileSync(join(home, '.pushary', 'config.json'), 'utf-8'))
    return isRecord(config) ? stringOf(config.apiKey).trim() || null : null
  } catch {
    return null
  }
}

const lastRpcMessage = (body, contentType) => {
  if (!stringOf(contentType).includes('text/event-stream')) return JSON.parse(body)
  const messages = body.split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => JSON.parse(line.slice('data:'.length).trim()))
  if (messages.length === 0) throw new Error('Pushary sent an empty event stream')
  return messages[messages.length - 1]
}

export const createPusharyClient = ({ apiKey, baseUrl, fetchImpl = fetch }) => async (name, args, timeoutMs) => {
  const response = await fetchImpl(`${baseUrl}${MCP_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`Pushary returned HTTP ${response.status}`)
  const message = lastRpcMessage(body, response.headers.get('content-type'))
  const text = message?.result?.content?.[0]?.text
  if (message?.error || message?.result?.isError || typeof text !== 'string') {
    throw new Error(stringOf(message?.error?.message) || stringOf(text) || 'Pushary returned no result')
  }
  return JSON.parse(text)
}

const withdrawQuestion = async (callTool, answer) => {
  if (!isRecord(answer) || answer.answered === true || !stringOf(answer.correlationId)) return
  await callTool('cancel_question', { correlationId: answer.correlationId }, WITHDRAW_TIMEOUT_MS).catch(() => {})
}

export const decidePreToolUse = async (envelope, options, { callTool, env }) => {
  const { tool_name: toolName, arguments: args } = envelope.payload
  if (!needsApproval(stringOf(toolName), isRecord(args) ? args : {}, options.gatedTools)) return CONTINUE
  if (!callTool) return fallbackDecision(options.unanswered)
  const askTimeoutMs = askTimeoutFor(options.waitMs)
  try {
    const answer = await callTool('ask_user', askArgumentsFor(envelope, askTimeoutMs, env), askTimeoutMs + RESPONSE_MARGIN_MS)
    await withdrawQuestion(callTool, answer)
    return decisionForAnswer(answer, options.unanswered)
  } catch {
    return fallbackDecision(options.unanswered)
  }
}

export const notificationFor = (envelope, env) => ({
  title: 'fx needs you',
  body: ATTENTION_MESSAGES[stringOf(envelope.payload.kind)] ?? 'fx is waiting for you in the terminal.',
  agentName: agentNameFor(envelope.invocation.workspace_root),
  ...(stringOf(envelope.invocation.session_id) ? { sessionId: truncate(stringOf(envelope.invocation.session_id), SESSION_ID_MAX) } : {}),
  ...(env === TEST_ENV ? { env: TEST_ENV } : {}),
})

export const notifyAttentionRequired = async (envelope, { callTool, env }) => {
  if (!callTool) return false
  try {
    await callTool('send_notification', notificationFor(envelope, env), NOTIFY_TIMEOUT_MS)
    return true
  } catch {
    return false
  }
}

const readStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

const respondOnce = () => {
  let responded = false
  return decision => {
    if (responded) return
    responded = true
    process.stdout.write(`${JSON.stringify(decision)}\n`)
  }
}

const main = async () => {
  const options = parseOptions(process.argv.slice(2))
  const apiKey = resolveApiKey(process.env, homedir())
  const baseUrl = stringOf(process.env.PUSHARY_BASE_URL).replace(/\/+$/, '') || DEFAULT_BASE_URL
  const deps = { callTool: apiKey ? createPusharyClient({ apiKey, baseUrl }) : null, env: stringOf(process.env.PUSHARY_ENV) }
  const respond = respondOnce()
  const deadline = setTimeout(() => {
    respond(fallbackDecision(options.unanswered))
    process.exit(0)
  }, options.waitMs + WITHDRAW_TIMEOUT_MS)
  deadline.unref()
  const envelope = parseEnvelope(await readStdin())
  const event = envelope?.event ?? stringOf(process.env.FX_HOOK_EVENT)
  if (event === 'PreToolUse') respond(envelope ? await decidePreToolUse(envelope, options, deps) : fallbackDecision(options.unanswered))
  else if (event === 'Stop') respond(ALLOW_STOP)
  else if (event === 'AttentionRequired' && envelope) process.exitCode = (await notifyAttentionRequired(envelope, deps)) ? 0 : 1
}

const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) await main()
