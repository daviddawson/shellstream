#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const net = require('net');

class ServerManager {
  constructor() {
    this.pidFile = path.join(__dirname, '.server.pid');
    this.serverPort = process.env.CLAUDE_SERVER_PORT || 3001;
    this.serverPath = path.join(__dirname, 'server.js');
  }

  async status() {
    const running = await this.isRunning();
    const pid = this.getPid();
    
    console.log('═══════════════════════════════════════');
    console.log('  Claude Server Status');
    console.log('═══════════════════════════════════════');
    console.log(`  Status:     ${running ? '✓ Running' : '✗ Stopped'}`);
    console.log(`  Port:       ${this.serverPort}`);
    if (pid) {
      console.log(`  PID:        ${pid}`);
    }
    if (running) {
      console.log(`  Web UI:     http://localhost:${this.serverPort}`);
      
      // Get session count
      try {
        const response = await this.fetchSessions();
        console.log(`  Sessions:   ${response.length} active`);
        console.log('═══════════════════════════════════════');
        
        if (response.length > 0) {
          console.log('\n  Active Sessions:');
          response.forEach(session => {
            const status = session.status === 'active' ? '●' : '○';
            console.log(`    ${status} ${session.projectName} @ ${session.hostname}`);
            console.log(`      └─ ${session.projectPath}`);
          });
        }
      } catch (err) {
        // Server might not be fully initialized
      }
    }
    console.log('═══════════════════════════════════════');
  }

  async stop() {
    const pid = this.getPid();
    
    if (!pid) {
      console.log('Server is not running (no PID file found)');
      return;
    }
    
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Stopped server (PID: ${pid})`);
      
      // Clean up PID file
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }
    } catch (err) {
      if (err.code === 'ESRCH') {
        console.log('Server process not found, cleaning up PID file');
        if (fs.existsSync(this.pidFile)) {
          fs.unlinkSync(this.pidFile);
        }
      } else {
        console.error('Error stopping server:', err.message);
      }
    }
  }

  async restart() {
    console.log('Restarting server...');
    await this.stop();
    
    // Wait for process to fully stop
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    await this.start();
  }

  async start() {
    const running = await this.isRunning();
    
    if (running) {
      console.log('Server is already running');
      await this.status();
      return;
    }
    
    const { spawn } = require('child_process');
    
    // Create log directory
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const logFile = path.join(logDir, `server-${new Date().toISOString().split('T')[0]}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    
    // Start server
    const serverProcess = spawn('node', [this.serverPath], {
      detached: true,
      stdio: ['ignore', logStream, logStream],
      env: {
        ...process.env,
        PORT: this.serverPort.toString()
      }
    });
    
    serverProcess.unref();
    
    // Save PID
    fs.writeFileSync(this.pidFile, serverProcess.pid.toString());
    
    console.log(`Server started with PID ${serverProcess.pid}`);
    console.log(`Logs: ${logFile}`);
    console.log(`Web UI: http://localhost:${this.serverPort}`);
  }

  async logs() {
    const logDir = path.join(__dirname, 'logs');
    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(logDir, `server-${today}.log`);
    
    if (!fs.existsSync(logFile)) {
      console.log('No log file found for today');
      return;
    }
    
    const { spawn } = require('child_process');
    spawn('tail', ['-f', logFile], {
      stdio: 'inherit'
    });
  }

  async clean() {
    console.log('Cleaning up old logs and temp files...');
    
    const logDir = path.join(__dirname, 'logs');
    if (fs.existsSync(logDir)) {
      const files = fs.readdirSync(logDir);
      const now = Date.now();
      const weekAgo = now - (7 * 24 * 60 * 60 * 1000);
      
      let cleaned = 0;
      files.forEach(file => {
        const filePath = path.join(logDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime.getTime() < weekAgo) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      });
      
      console.log(`Cleaned ${cleaned} old log files`);
    }
    
    // Clean up orphaned PID file
    const pid = this.getPid();
    if (pid && !await this.isProcessRunning(pid)) {
      fs.unlinkSync(this.pidFile);
      console.log('Removed orphaned PID file');
    }
  }

  getPid() {
    if (fs.existsSync(this.pidFile)) {
      const pid = fs.readFileSync(this.pidFile, 'utf8').trim();
      return parseInt(pid, 10);
    }
    return null;
  }

  async isRunning() {
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

  async isProcessRunning(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return false;
    }
  }

  async fetchSessions() {
    return new Promise((resolve, reject) => {
      const http = require('http');
      
      const options = {
        hostname: 'localhost',
        port: this.serverPort,
        path: '/api/sessions',
        method: 'GET'
      };
      
      const req = http.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      });
      
      req.on('error', reject);
      req.setTimeout(1000, () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
      
      req.end();
    });
  }

  printHelp() {
    console.log(`
Claude Server Manager

Usage: node server-manager.js [command]

Commands:
  status    Show server status and active sessions
  start     Start the server if not running
  stop      Stop the server
  restart   Restart the server
  logs      Tail the server logs
  clean     Clean up old logs (> 7 days)
  help      Show this help message

Environment Variables:
  CLAUDE_SERVER_PORT    Server port (default: 3001)

Examples:
  node server-manager.js status
  node server-manager.js stop
  CLAUDE_SERVER_PORT=4000 node server-manager.js start
`);
  }
}

// Main execution
async function main() {
  const manager = new ServerManager();
  const command = process.argv[2] || 'status';
  
  try {
    switch (command) {
      case 'status':
        await manager.status();
        break;
      case 'start':
        await manager.start();
        break;
      case 'stop':
        await manager.stop();
        break;
      case 'restart':
        await manager.restart();
        break;
      case 'logs':
        await manager.logs();
        break;
      case 'clean':
        await manager.clean();
        break;
      case 'help':
        manager.printHelp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        manager.printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = ServerManager;
