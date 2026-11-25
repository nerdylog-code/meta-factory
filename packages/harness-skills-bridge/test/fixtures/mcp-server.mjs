/**
 * A real (tiny) MCP server over stdio, used to exercise the client for real.
 *
 * Implements the three methods the factory needs: initialize, tools/list,
 * tools/call. It also misbehaves on demand (via env) so failure paths can be
 * tested against a genuine server rather than a mock:
 *   MCP_FIXTURE_MODE=crash-on-init  -> exit immediately
 *   MCP_FIXTURE_MODE=hang           -> never answer
 *   MCP_FIXTURE_MODE=tool-error     -> tools/call returns isError
 */
import { createInterface } from 'node:readline';

const mode = process.env['MCP_FIXTURE_MODE'] ?? 'normal';

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

if (mode === 'crash-on-init') {
  process.stderr.write('fixture: crashing on purpose\n');
  process.exit(1);
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the given text back. Used to prove a round trip works.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 500 },
        loud: { type: 'boolean' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notification
  if (mode === 'hang') return; // never answer

  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture-server', version: '0.0.1' },
        },
      });
      return;

    case 'tools/list':
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
      return;

    case 'tools/call': {
      const params = msg.params ?? {};
      const args = params.arguments ?? {};
      // In tool-error mode EVERY known tool reports a soft failure, so the
      // client's isError path can be exercised against a real server.
      if (mode === 'tool-error' && (params.name === 'echo' || params.name === 'add')) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'simulated tool failure' }], isError: true },
        });
        return;
      }
      if (params.name === 'echo') {
        const text = String(args['text'] ?? '');
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: args['loud'] ? text.toUpperCase() : text }],
          },
        });
        return;
      }
      if (params.name === 'add') {
        const a = Number(args['a'] ?? 0);
        const b = Number(args['b'] ?? 0);
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(a + b) }] } });
        return;
      }
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32602, message: `unknown tool '${params.name}'` },
      });
      return;
    }

    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no such method '${msg.method}'` } });
  }
});


