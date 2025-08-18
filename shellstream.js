#!/usr/bin/env node

// shellstream - Stream any terminal session to the web
// https://github.com/yourusername/shellstream

const pty = require('node-pty');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const net = require('net');

class Shellstream {
  constructor(command, args = [], options = {}) {
    this.command = command;
    this.args = args;
    this.sessionId = options.sessionId || uuidv4();
    this.serverPort = options.serverPort || process.env.SHELLSTREAM_PORT || 47832;
    this.serverUrl = options.serverUrl || process.env.SHELLSTREAM_SERVER || `ws://localhost:${this.serverPort}`;
    this.projectPath = options.cwd || process.cwd();
    this.projectName = options.name || `${command}-${path.basename(this.projectPath)}`;
    this.isInteractive = process.stdin.isTTY;
    this.ptyProcess = null;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    this.outputBuffer = [];
    this.inputHistory = [];
    this.connected = false;
    this.serverAutoStarted = false;
    this.suppressLocalOutput = false; // Flag to suppress output when remote input is active
    
    // Configuration
    this.config = {
      enableRemote: options.enableRemote !== false,
      autoStartServer: options.autoStartServer !== false,
      captureOutput: true,
      allowRemoteInput: true,
      bufferSize: 1000,
      serverPath: options.serverPath || path.join(__dirname, 'server.js'),
      env: options.env || process.env,
      shell: options.shell || false,
      ...options.config
    };
    
  }

  async start() {
    console.error(`╔════════════════════════════════════════════╗`);
    console.error(`║           🚀 SHELLSTREAM ACTIVE            ║`);
    console.error(`╚════════════════════════════════════════════╝`);
    console.error(`[Shellstream] Streaming: ${this.command} ${this.args.join(' ')}`);
    console.error(`[Shellstream] Session ID: ${this.sessionId}`);
    console.error(`[Shellstream] Directory: ${this.projectPath}`);
    
    // Ensure server is running if remote is enabled
    if (this.config.enableRemote && this.config.autoStartServer) {
      await this.ensureServerRunning();
    }
    
    // Start the process
    await this.spawnProcess();
    
    // Connect to central server if enabled
    if (this.config.enableRemote) {
      await this.connectToServer();
    }
    
    // Set up local input handling
    this.setupLocalInput();
    
    // Handle process termination
    this.setupCleanup();
  }

  async spawnProcess() {
    console.error(`[Shellstream] Starting process...`);
    
    // Spawn process in a PTY
    this.ptyProcess = pty.spawn(this.command, this.args, {
      name: 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd: this.projectPath,
      env: this.config.env,
      shell: this.config.shell
    });

    // Handle PTY output - conditionally pass through to local terminal and capture
    this.ptyProcess.onData((data) => {
      // Only pass through to local terminal if not suppressing (i.e., not from remote input)
      if (!this.suppressLocalOutput) {
        process.stdout.write(data);
      }
      
      // Capture and buffer output
      if (this.config.captureOutput) {
        this.bufferOutput(data);
      }
      
      // Send to server if connected
      if (this.connected && this.ws) {
        this.sendToServer({
          type: 'output',
          data: data,
          timestamp: Date.now()
        });
      }
      
    });

    // Handle PTY exit
    this.ptyProcess.onExit(({ exitCode, signal }) => {
      console.error(`\n[Monitor] Process exited (code: ${exitCode}, signal: ${signal})`);
      
      // Send exit notification to server
      if (this.connected) {
        this.sendToServer({
          type: 'process_exit',
          exitCode,
          signal,
          timestamp: Date.now()
        });
      }
      
      this.cleanup();
      process.exit(exitCode);
    });

    // Handle terminal resize
    process.stdout.on('resize', () => {
      this.ptyProcess.resize(
        process.stdout.columns,
        process.stdout.rows
      );
      
      if (this.connected) {
        this.sendToServer({
          type: 'resize',
          cols: process.stdout.columns,
          rows: process.stdout.rows
        });
      }
    });
  }


  // ... (rest of the methods remain largely the same as claude-wrapper.js)
  
  async ensureServerRunning() {
    const isRunning = await this.isServerRunning();
    
    if (!isRunning) {
      console.error(`[Monitor] Server not detected on port ${this.serverPort}, starting it...`);
      await this.startServer();
    } else {
      console.error(`[Monitor] Server already running on port ${this.serverPort}`);
    }
  }

  async isServerRunning() {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(1000);
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', () => {
        resolve(false);
      });
      socket.connect(this.serverPort, 'localhost');
    });
  }

  async startServer() {
    return new Promise((resolve) => {
      if (!fs.existsSync(this.config.serverPath)) {
        console.error(`[Monitor] Warning: Server file not found at ${this.config.serverPath}`);
        return resolve();
      }
      
      const logDir = path.join(__dirname, 'logs');
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      const serverProcess = spawn('node', [this.config.serverPath], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
          ...process.env,
          PORT: this.serverPort.toString(),
          NODE_ENV: 'production'
        }
      });
      
      serverProcess.unref();
      
      const pidFile = path.join(__dirname, '.server.pid');
      fs.writeFileSync(pidFile, serverProcess.pid.toString());
      
      console.error(`[Monitor] Server started with PID ${serverProcess.pid}`);
      console.error(`[Monitor] Web UI available at http://localhost:${this.serverPort}`);
      this.serverAutoStarted = true;
      
      setTimeout(() => {
        this.isServerRunning().then(running => {
          if (running) {
            console.error('[Monitor] Server successfully started');
            resolve();
          } else {
            console.error('[Monitor] Server failed to start, continuing without remote features');
            resolve();
          }
        });
      }, 2000);
    });
  }

  async connectToServer() {
    return new Promise((resolve) => {
      console.error(`[Monitor] Connecting to server: ${this.serverUrl}`);
      
      this.ws = new WebSocket(this.serverUrl);
      
      this.ws.on('open', () => {
        console.error('[Monitor] Connected to central server');
        console.error(`[Monitor] Web UI: http://localhost:${this.serverPort}`);
        this.connected = true;
        this.reconnectAttempts = 0;
        
        // Register session with program info
        this.sendToServer({
          type: 'register',
          sessionId: this.sessionId,
          projectName: this.projectName,
          projectPath: this.projectPath,
          command: this.command,
          args: this.args,
          hostname: os.hostname(),
          platform: os.platform(),
          cols: process.stdout.columns,
          rows: process.stdout.rows
        });
        
        // Send buffered output if any
        if (this.outputBuffer.length > 0) {
          this.sendToServer({
            type: 'history',
            data: this.outputBuffer
          });
        }
        
        resolve();
      });
      
      this.ws.on('message', (message) => {
        try {
          const msg = JSON.parse(message);
          this.handleServerMessage(msg);
        } catch (err) {
          console.error('[Monitor] Error parsing server message:', err);
        }
      });
      
      this.ws.on('close', () => {
        console.error('[Monitor] Disconnected from server');
        this.connected = false;
        this.attemptReconnect();
      });
      
      this.ws.on('error', (err) => {
        if (this.reconnectAttempts === 0) {
          console.error('[Monitor] Could not connect to server, continuing locally');
        }
      });
      
      setTimeout(() => resolve(), 2000);
    });
  }

  setupLocalInput() {
    if (this.isInteractive) {
      process.stdin.setRawMode(true);
    }
    
    process.stdin.setEncoding('utf8');
    
    process.stdin.on('data', (data) => {
      // Send to process PTY
      if (this.ptyProcess) {
        this.ptyProcess.write(data);
      }
      
      // Track input history
      this.inputHistory.push({
        data: data,
        timestamp: Date.now()
      });
      
      // Send to server
      if (this.connected) {
        this.sendToServer({
          type: 'input',
          data: data,
          source: 'local',
          timestamp: Date.now()
        });
      }
      
      // Handle special commands
      this.handleSpecialCommands(data);
    });
  }

  handleSpecialCommands(data) {
    // Ctrl+Q: Show session info
    if (data === '\x11') {
      console.error(`\n[Monitor] Session ID: ${this.sessionId}`);
      console.error(`[Monitor] Command: ${this.command} ${this.args.join(' ')}`);
      console.error(`[Monitor] Server: ${this.connected ? 'Connected' : 'Disconnected'}`);
      console.error(`[Monitor] Web UI: http://localhost:${this.serverPort}`);
      console.error(`[Monitor] Buffer: ${this.outputBuffer.length} entries`);
      console.error(`[Monitor] Project: ${this.projectName}`);
    }
  }

  handleServerMessage(msg) {
    switch (msg.type) {
      case 'input':
        // Remote input injection
        if (this.config.allowRemoteInput && this.ptyProcess) {
          this.ptyProcess.write(msg.data);
          
          this.inputHistory.push({
            data: msg.data,
            source: 'remote',
            timestamp: Date.now()
          });
        }
        break;
        
      case 'command':
        // Execute special commands
        this.executeRemoteCommand(msg);
        break;
        
      case 'request_history':
        // Send output history
        this.sendToServer({
          type: 'history',
          data: this.outputBuffer
        });
        break;
        
      case 'ping':
        // Respond to ping
        this.sendToServer({ type: 'pong' });
        break;
    }
  }

  executeRemoteCommand(msg) {
    switch (msg.command) {
      case 'approve':
      case 'yes':
        if (this.ptyProcess) {
          this.ptyProcess.write('y\n');
          console.error('[Monitor] Remote approval sent');
        }
        break;
        
      case 'reject':
      case 'no':
        if (this.ptyProcess) {
          this.ptyProcess.write('n\n');
          console.error('[Monitor] Remote rejection sent');
        }
        break;
        
      case 'interrupt':
        if (this.ptyProcess) {
          this.ptyProcess.write('\x03');
          console.error('[Monitor] Remote interrupt sent (Ctrl+C)');
        }
        break;
        
      case 'eof':
        if (this.ptyProcess) {
          this.ptyProcess.write('\x04');
          console.error('[Monitor] Remote EOF sent (Ctrl+D)');
        }
        break;
        
      case 'clear':
        if (this.ptyProcess) {
          this.ptyProcess.write('\x0c');
        }
        break;
    }
  }

  bufferOutput(data) {
    this.outputBuffer.push({
      data: data,
      timestamp: Date.now()
    });
    
    // Limit buffer size
    if (this.outputBuffer.length > this.config.bufferSize) {
      this.outputBuffer.shift();
    }
  }

  sendToServer(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        ...message,
        sessionId: this.sessionId
      }));
    }
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[Monitor] Max reconnection attempts reached');
      return;
    }
    
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.error(`[Monitor] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      this.connectToServer();
    }, delay);
  }

  setupCleanup() {
    const cleanup = () => {
      console.error('\n[Monitor] Cleaning up...');
      this.cleanup();
      process.exit(0);
    };
    
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('exit', () => this.cleanup());
  }

  cleanup() {
    if (this.ptyProcess) {
      this.ptyProcess.kill();
    }
    
    if (this.ws) {
      this.sendToServer({
        type: 'disconnect',
        timestamp: Date.now()
      });
      this.ws.close();
    }
    
    if (this.isInteractive && process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
  }
}

// Main execution
if (require.main === module) {
  // Parse command line arguments
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
🚀 Shellstream - Stream terminal sessions to the web

USAGE
  shellstream <command> [args...]
  ss <command> [args...]                    # Short alias

EXAMPLES  
  shellstream bash                          # Stream a bash shell
  shellstream vim config.json              # Stream vim session
  shellstream npm run dev                   # Stream development server
  shellstream docker-compose up            # Stream container logs
  shellstream python -m http.server        # Stream Python server

KEYBOARD SHORTCUTS
  Ctrl+Q      Show session info and web URL
  Ctrl+C      Interrupt the running process

WEB INTERFACE
  http://localhost:47832                    # Access the web UI
  
Visit the web interface to view your terminal sessions from any device.
Multiple sessions are grouped by directory with tabbed interface.
    `);
    process.exit(0);
  }
  
  // Extract command and arguments
  const command = args[0];
  const commandArgs = args.slice(1);
  
  // Create wrapper instance
  const wrapper = new Shellstream(command, commandArgs, {
    serverUrl: process.env.MONITOR_SERVER_URL,
    serverPort: process.env.MONITOR_SERVER_PORT,
    sessionId: process.env.MONITOR_SESSION_ID,
    name: process.env.MONITOR_NAME
  });
  
  // Start monitoring
  wrapper.start().catch(err => {
    console.error('[Monitor] Failed to start:', err);
    process.exit(1);
  });
}

module.exports = Shellstream;
