import { spawn } from 'child_process';
import readline from 'readline';

const SERVER_URL = 'http://127.0.0.1:4096';
const AUTH_USERNAME = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
const AUTH_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || '';

function getAuthHeaders(): HeadersInit {
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (AUTH_PASSWORD) {
    const credentials = Buffer.from(`${AUTH_USERNAME}:${AUTH_PASSWORD}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  }
  return headers;
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
    throw new Error(`Failed to create session (${response.status}): ${error}`);
  }

  const session = await response.json();
  return session.id;
}

async function sendMessage(sessionId: string, message: string) {
  console.log('Sending message to server...');
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

  console.log(`Server responded with status: ${response.status}`);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to send message (${response.status}): ${error}`);
  }

  const data = await response.json();
  console.log(`Received ${data.parts?.length || 0} parts`);
  return data;
}

async function formatResponse(parts: any[]): Promise<string> {
  const output: string[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      output.push(part.text);
    } else if (part.type === 'tool_use' || part.type === 'tool_result') {
      continue;
    }
  }

  return output.join('\n').trim();
}

async function main() {
  const serverProcess = await startOpenCodeServer();

  try {
    const sessionId = await createSession();
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
              console.log('Sending...');
              const response = await sendMessage(sessionId, input);
              const formatted = await formatResponse(response.parts);
              console.log('\n' + formatted + '\n');
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