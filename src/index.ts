import type { HeadersInit } from 'bun';
import { spawn } from 'child_process';
import readline from 'readline';

const SERVER_URL = 'http://127.0.0.1:4096';
const AUTH_USERNAME = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
const AUTH_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || '';

function getAuthHeaders(includeContentType: boolean = true): HeadersInit {
  const headers: HeadersInit = {};
  if (AUTH_PASSWORD) {
    const credentials = Buffer.from(`${AUTH_USERNAME}:${AUTH_PASSWORD}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  }
  if (includeContentType) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function processPart(part: any): void {
  switch (part.type) {
    case 'step-start':
      console.log('⚙️  Processing...');
      break;

    case 'reasoning':
      console.log('💭 Thinking...');
      if (part.text) {
        console.log(`   ${part.text}`);
      }
      break;

    case 'text':
      if (part.text) {
        console.log(`\n${part.text}\n`);
      }
      break;

    case 'step-finish':
      console.log('✓ Done');
      break;

    case 'tool_use':
      console.log(`🔧 Using tool: ${part.name || 'unknown'}`);
      break;

    case 'tool_result':
      break;

    default:
      break;
  }
}

async function startEventListener(): Promise<void> {
  try {
    const response = await fetch(`${SERVER_URL}/event`, {
      headers: getAuthHeaders(false)
    });

    if (!response.ok) {
      console.warn('Failed to connect to event stream');
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      try {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
                        console.log(line)

          if (line.startsWith('data: ')) {
            const data = line.substring(6);
            if (data === '[DONE]') continue;

            try {
              const part = JSON.parse(data);
              //console.log(part)
              processPart(part);
            } catch (error) {
            }
          }
        }
      } catch (error) {
        break;
      }
    }
  } catch (error) {
  }
}

async function startOpenCodeServer() {
  const serverProcess = spawn('opencode', ['serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    cwd: process.cwd()
  });

  let started = false;

  serverProcess.stdout.on('data', (data) => {
    if (!started) {
      started = true;
      console.log('OpenCode server started');
    }
  });

  serverProcess.stderr.on('data', (data) => {
    if (!started) {
      started = true;
      console.log('OpenCode server started');
    }
  });

  serverProcess.on('error', (error) => {
    console.error('Failed to start OpenCode server:', error.message);
    process.exit(1);
  });

  serverProcess.on('exit', (code) => {
    console.log(`OpenCode server exited with code ${code}`);
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    serverProcess.kill('SIGINT');
  });

  await new Promise(resolve => setTimeout(resolve, 3000));
  return serverProcess;
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number = 120000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeout);
    return response;
  } catch (error: any) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

async function createSession(): Promise<string> {
  const response = await fetchWithTimeout(`${SERVER_URL}/session`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({})
  }, 10000);

  if (!response.ok) {
    const error = await response.text();
    if (response.status === 401 && !AUTH_PASSWORD) {
      throw new Error('Server requires authentication. Set OPENCODE_SERVER_PASSWORD environment variable.');
    }
    throw new Error(`Failed to create session (${response.status}): ${error}`);
  }

  const session = await response.json();
  return session.id;
}

async function sendMessage(sessionId: string, message: string) {
  const response = await fetchWithTimeout(`${SERVER_URL}/session/${sessionId}/message`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      model: {
        modelID: 'big-pickle',
        providerID: 'opencode'
      },
      parts: [{ type: 'text', text: message }]
    })
  }, 180000);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to send message (${response.status}): ${error}`);
  }

  // all of these messages should have been handled as server events
  //const data = await response.json();
  //
  //if (data.parts) {
  //  for (const part of data.parts) {
  //    //processPart(part);
  //    await new Promise(resolve => setTimeout(resolve, 100));
  //  }
  //}
}

async function runInit(sessionId: string): Promise<void> {
  console.log('Running /init command (analyzing project and creating AGENTS.md)...');
  const response = await fetchWithTimeout(`${SERVER_URL}/session/${sessionId}/init`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({})
  }, 180000);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to run /init (${response.status}): ${error}`);
  }

  const result = await response.json();
  console.log('\n' + (result ? 'AGENTS.md created/updated successfully.' : 'No changes made to AGENTS.md.') + '\n');
}

async function runModel(sessionId: string): Promise<void> {
  console.log('Fetching available models...');
  const response = await fetchWithTimeout(`${SERVER_URL}/config/providers`, {
    method: 'GET',
    headers: getAuthHeaders()
  }, 10000);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch models (${response.status}): ${error}`);
  }

  const config = await response.json();
  console.log('\nAvailable models:');

  for (const provider of config.providers || []) {
    console.log(`\n${provider.name}:`);
    const models = Object.values(provider.models || {}) as any[];
    for (const model of models) {
      console.log(`  - ${model.id}: ${model.name || ''}`);
    }
  }
  console.log();
}

async function runUndo(sessionId: string): Promise<void> {
  console.log('Fetching session messages...');

  const messagesRes = await fetchWithTimeout(`${SERVER_URL}/session/${sessionId}/message`, {
    method: 'GET',
    headers: getAuthHeaders()
  }, 10000);

  if (!messagesRes.ok) {
    const error = await messagesRes.text();
    throw new Error(`Failed to fetch messages (${messagesRes.status}): ${error}`);
  }

  const messages = await messagesRes.json();

  if (!messages || messages.length === 0) {
    console.log('No messages to undo.\n');
    return;
  }

  const lastMessage = messages[messages.length - 1];

  if (!lastMessage || !lastMessage.info) {
    console.log('No valid message to undo.\n');
    return;
  }

  if (lastMessage.info.role !== 'assistant') {
    console.log('Last message is not an AI response, nothing to undo.\n');
    return;
  }

  console.log(`Reverting last assistant message (${lastMessage.info.id})...`);

  const revertRes = await fetchWithTimeout(`${SERVER_URL}/session/${sessionId}/revert`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      messageID: lastMessage.info.id
    })
  }, 30000);

  if (!revertRes.ok) {
    const error = await revertRes.text();
    throw new Error(`Failed to revert message (${revertRes.status}): ${error}`);
  }

  console.log('Successfully reverted last message.\n');
}

async function main() {
  const serverProcess = await startOpenCodeServer();

  if (!AUTH_PASSWORD) {
    console.warn('Warning: OPENCODE_SERVER_PASSWORD not set. Authentication may be required.');
  }

  try {
    const sessionId = await createSession();
    startEventListener();
    console.log('Session created. Type your message and press Enter (Ctrl+C to exit):\n');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const ask = (): Promise<void> => {
      return new Promise((resolve) => {
        rl.question('> ', async (input) => {
          if (input.trim()) {
            try {
              const trimmed = input.trim();
              
              if (trimmed === '/init') {
                await runInit(sessionId);
              } else if (trimmed === '/model' || trimmed === '/models') {
                await runModel(sessionId);
              } else if (trimmed === '/undo') {
                await runUndo(sessionId);
              } else if (trimmed === '/help') {
                console.log('\nAvailable commands:');
                console.log('  /init   - Analyze project and create/update AGENTS.md');
                console.log('  /model  - List available models');
                console.log('  /undo   - Undo last message');
                console.log('  /help   - Show this help message');
                console.log();
              } else {
                console.log('Sending...');
                await sendMessage(sessionId, input);
              }
            } catch (error: any) {
              console.error('Error:', error.message);
            }
          }
          ask();
        });
      });
    };

    ask();
  } catch (error: any) {
    console.error('Error:', error.message);
    serverProcess.kill();
    process.exit(1);
  }
}

main().catch(console.error);