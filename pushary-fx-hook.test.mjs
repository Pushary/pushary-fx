import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CONTINUE,
  DENIED_REASON,
  UNANSWERED_REASON,
  askArgumentsFor,
  askTimeoutFor,
  commandHead,
  createPusharyClient,
  decidePreToolUse,
  needsApproval,
  notifyAttentionRequired,
  parseEnvelope,
  parseOptions,
  redactActionBody,
  resolveApiKey,
} from './pushary-fx-hook.mjs'

const envelopeFor = (event, payload) => ({
  schema_version: 1,
  event,
  invocation: { scope: 'interactive', workspace_root: '/Users/example/src/api', session_id: 'sess_1', subagent_id: null, turn_id: 4 },
  payload,
})

const terminalCall = (command, action = 'exec') =>
  envelopeFor('PreToolUse', { step_index: 1, call_id: 'call_9', tool_name: 'terminal', arguments: { action, command, timeout_ms: 1000 } })

const recordingClient = answers => {
  const calls = []
  const callTool = async (name, args) => {
    calls.push({ name, args })
    const answer = answers[name]
    if (answer instanceof Error) throw answer
    return answer ?? {}
  }
  return { calls, callTool }
}

const defaults = parseOptions([])

describe('parseEnvelope', () => {
  it('accepts a schema 1 envelope', () => {
    assert.equal(parseEnvelope(JSON.stringify(terminalCall('ls')))?.event, 'PreToolUse')
  })

  it('rejects malformed JSON, another schema version and a missing payload', () => {
    assert.equal(parseEnvelope('{not json'), null)
    assert.equal(parseEnvelope(JSON.stringify({ ...terminalCall('ls'), schema_version: 2 })), null)
    assert.equal(parseEnvelope(JSON.stringify({ schema_version: 1, event: 'PreToolUse', invocation: {} })), null)
  })
})

describe('parseOptions', () => {
  it('keeps the defaults for invalid values and clamps the wait', () => {
    assert.deepEqual(parseOptions(['--unanswered', 'maybe', '--wait-ms', 'soon']), defaults)
    assert.equal(parseOptions(['--wait-ms', '999999']).waitMs, 58_000)
    assert.equal(parseOptions(['--wait-ms', '10']).waitMs, 5_000)
  })

  it('reads the unanswered policy and the gated tool list', () => {
    const options = parseOptions(['--unanswered', 'block', '--gate', 'terminal, write_file'])
    assert.equal(options.unanswered, 'block')
    assert.deepEqual([...options.gatedTools], ['terminal', 'write_file'])
  })
})

describe('needsApproval', () => {
  it('gates terminal calls that run something, and destructive file tools', () => {
    assert.equal(needsApproval('terminal', { action: 'exec' }, defaults.gatedTools), true)
    assert.equal(needsApproval('terminal', { action: 'write' }, defaults.gatedTools), true)
    assert.equal(needsApproval('delete_file', { path: '/tmp/a' }, defaults.gatedTools), true)
  })

  it('lets reads and terminal inspection through', () => {
    assert.equal(needsApproval('terminal', { action: 'read' }, defaults.gatedTools), false)
    assert.equal(needsApproval('read_file', { path: '/tmp/a' }, defaults.gatedTools), false)
    assert.equal(needsApproval('write_file', { path: '/tmp/a' }, defaults.gatedTools), false)
  })
})

describe('askArgumentsFor', () => {
  it('describes a command with its head as the target and the call id as the tool use id', () => {
    const args = askArgumentsFor(terminalCall('git push origin main'), 47_000, '')
    assert.equal(args.question, 'Allow fx to run: git push origin main')
    assert.equal(args.toolTarget, 'git push')
    assert.equal(args.toolUseId, 'call_9')
    assert.equal(args.sessionId, 'sess_1')
    assert.equal(args.agentName, 'fx - api')
    assert.equal(args.timeoutMs, 47_000)
    assert.equal('env' in args, false)
  })

  it('redacts secrets from what leaves the machine', () => {
    const args = askArgumentsFor(terminalCall('curl -H "Authorization: Bearer abc.def" https://x.test?token=hunter2'), 47_000, '')
    assert.doesNotMatch(JSON.stringify(args), /abc\.def|hunter2/)
  })

  it('marks the question as a test when PUSHARY_ENV is test', () => {
    assert.equal(askArgumentsFor(terminalCall('ls'), 47_000, 'test').env, 'test')
  })

  it('describes a rename with both paths', () => {
    const rename = envelopeFor('PreToolUse', { call_id: 'c', tool_name: 'rename_file', arguments: { old_path: 'a.ts', new_path: 'b.ts' } })
    assert.equal(askArgumentsFor(rename, 47_000, '').question, 'Allow fx to rename a.ts to b.ts')
  })
})

describe('commandHead', () => {
  it('keeps a subcommand and drops paths and flags', () => {
    assert.equal(commandHead('git push origin main'), 'git push')
    assert.equal(commandHead('npm run build'), 'npm run')
    assert.equal(commandHead('touch /tmp/marker.txt'), 'touch')
    assert.equal(commandHead('rm -rf build'), 'rm')
  })
})

describe('redactActionBody', () => {
  it('redacts long high-entropy runs only in the command body', () => {
    assert.match(redactActionBody(`export KEY=${'A1b2'.repeat(12)}`), /\[redacted\]/)
  })
})

describe('decidePreToolUse', () => {
  it('does not call Pushary for a call it does not gate', async () => {
    const client = recordingClient({})
    const read = envelopeFor('PreToolUse', { call_id: 'c', tool_name: 'read_file', arguments: { path: 'a' } })
    assert.deepEqual(await decidePreToolUse(read, defaults, { callTool: client.callTool, env: '' }), CONTINUE)
    assert.equal(client.calls.length, 0)
  })

  it('continues when the user approves on the phone', async () => {
    const client = recordingClient({ ask_user: { answered: true, value: 'yes', correlationId: 'q1' } })
    assert.deepEqual(await decidePreToolUse(terminalCall('rm -rf build'), defaults, { callTool: client.callTool, env: '' }), CONTINUE)
    assert.deepEqual(client.calls.map(call => call.name), ['ask_user'])
  })

  it('blocks with a reason when the user denies on the phone', async () => {
    const client = recordingClient({ ask_user: { answered: true, value: 'no', correlationId: 'q1' } })
    assert.deepEqual(await decidePreToolUse(terminalCall('rm -rf build'), defaults, { callTool: client.callTool, env: '' }), { action: 'block', reason: DENIED_REASON })
  })

  it('withdraws an unanswered question and hands the call back to fx by default', async () => {
    const client = recordingClient({ ask_user: { answered: false, status: 'pending', correlationId: 'q2' } })
    assert.deepEqual(await decidePreToolUse(terminalCall('rm -rf build'), defaults, { callTool: client.callTool, env: '' }), CONTINUE)
    assert.deepEqual(client.calls.map(call => call.name), ['ask_user', 'cancel_question'])
    assert.deepEqual(client.calls[1].args, { correlationId: 'q2' })
  })

  it('blocks an unanswered call when configured for full-access sessions', async () => {
    const client = recordingClient({ ask_user: { answered: false, correlationId: 'q3' } })
    const options = parseOptions(['--unanswered', 'block'])
    assert.deepEqual(await decidePreToolUse(terminalCall('rm -rf build'), options, { callTool: client.callTool, env: '' }), { action: 'block', reason: UNANSWERED_REASON })
  })

  it('never lets a failure become an approval under the block policy', async () => {
    const client = recordingClient({ ask_user: new Error('network down') })
    const options = parseOptions(['--unanswered', 'block'])
    assert.equal((await decidePreToolUse(terminalCall('rm -rf build'), options, { callTool: client.callTool, env: '' })).action, 'block')
    assert.equal((await decidePreToolUse(terminalCall('rm -rf build'), options, { callTool: null, env: '' })).action, 'block')
  })

  it('treats any answer other than yes or no as unanswered', async () => {
    const client = recordingClient({ ask_user: { answered: true, value: 'defer', correlationId: 'q4' } })
    const options = parseOptions(['--unanswered', 'block'])
    assert.equal((await decidePreToolUse(terminalCall('rm -rf build'), options, { callTool: client.callTool, env: '' })).action, 'block')
  })
})

describe('askTimeoutFor', () => {
  it('leaves room to answer fx before the wait ends and never exceeds the ask_user cap', () => {
    assert.equal(askTimeoutFor(50_000), 47_000)
    assert.equal(askTimeoutFor(58_000), 55_000)
  })
})

describe('notifyAttentionRequired', () => {
  it('sends a push that says what fx is waiting for', async () => {
    const client = recordingClient({ send_notification: { sent: 1 } })
    const delivered = await notifyAttentionRequired(envelopeFor('AttentionRequired', { kind: 'question' }), { callTool: client.callTool, env: 'test' })
    assert.equal(delivered, true)
    assert.equal(client.calls[0].args.body, 'fx asked you a question in the terminal.')
    assert.equal(client.calls[0].args.env, 'test')
  })

  it('reports a failed delivery', async () => {
    const client = recordingClient({ send_notification: new Error('HTTP 500') })
    assert.equal(await notifyAttentionRequired(envelopeFor('AttentionRequired', { kind: 'permission' }), { callTool: client.callTool, env: '' }), false)
    assert.equal(await notifyAttentionRequired(envelopeFor('AttentionRequired', { kind: 'permission' }), { callTool: null, env: '' }), false)
  })
})

describe('resolveApiKey', () => {
  it('prefers PUSHARY_API_KEY, then the key pushary setup saved', () => {
    const home = mkdtempSync(join(tmpdir(), 'pushary-fx-home-'))
    try {
      mkdirSync(join(home, '.pushary'))
      writeFileSync(join(home, '.pushary', 'config.json'), JSON.stringify({ apiKey: 'pk_saved.key' }))
      assert.equal(resolveApiKey({ PUSHARY_API_KEY: 'pk_env.key' }, home), 'pk_env.key')
      assert.equal(resolveApiKey({}, home), 'pk_saved.key')
      assert.equal(resolveApiKey({}, join(home, 'missing')), null)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('the hook process', () => {
  const HOOK = fileURLToPath(new URL('./pushary-fx-hook.mjs', import.meta.url))
  const runHook = (input, args, env) => spawnSync(process.execPath, [HOOK, ...args], {
    input,
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, HOME: join(tmpdir(), 'pushary-fx-no-home'), ...env },
  })

  it('continues an ungated call without a key or network', () => {
    const read = JSON.stringify(envelopeFor('PreToolUse', { call_id: 'c', tool_name: 'read_file', arguments: { path: 'a' } }))
    const result = runHook(read, [], {})
    assert.equal(result.status, 0)
    assert.deepEqual(JSON.parse(result.stdout), CONTINUE)
  })

  it('blocks an envelope it cannot read when unanswered calls are blocked', () => {
    const future = JSON.stringify({ ...terminalCall('rm -rf build'), schema_version: 2 })
    const result = runHook(future, ['--unanswered', 'block'], { FX_HOOK_EVENT: 'PreToolUse' })
    assert.deepEqual(JSON.parse(result.stdout), { action: 'block', reason: UNANSWERED_REASON })
  })

  it('allows a Stop and prints nothing for observation events', () => {
    assert.deepEqual(JSON.parse(runHook(JSON.stringify(envelopeFor('Stop', {})), [], {}).stdout), { action: 'allow' })
    assert.equal(runHook(JSON.stringify(envelopeFor('PostTurnEnd', { outcome: 'completed' })), [], {}).stdout, '')
  })

  it('exits non-zero when an attention push cannot be delivered', () => {
    const result = runHook(JSON.stringify(envelopeFor('AttentionRequired', { kind: 'permission' })), [], {})
    assert.equal(result.status, 1)
  })
})

describe('createPusharyClient', () => {
  const respondWith = (body, contentType, status = 200) => async () =>
    new Response(body, { status, headers: { 'content-type': contentType } })

  it('reads a tool result from an event stream', async () => {
    const rpc = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ answered: true, value: 'yes' }) }] } }
    const callTool = createPusharyClient({ apiKey: 'k', baseUrl: 'https://x.test', fetchImpl: respondWith(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`, 'text/event-stream') })
    assert.deepEqual(await callTool('ask_user', {}, 1000), { answered: true, value: 'yes' })
  })

  it('throws on a tool error and on an HTTP failure', async () => {
    const toolError = { jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'Input validation error' }] } }
    await assert.rejects(createPusharyClient({ apiKey: 'k', baseUrl: 'https://x.test', fetchImpl: respondWith(JSON.stringify(toolError), 'application/json') })('ask_user', {}, 1000), /Input validation error/)
    await assert.rejects(createPusharyClient({ apiKey: 'k', baseUrl: 'https://x.test', fetchImpl: respondWith('nope', 'text/plain', 401) })('ask_user', {}, 1000), /HTTP 401/)
  })
})
