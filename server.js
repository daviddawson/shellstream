const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class ShellstreamServer {
  constructor(port = 47832) {
    this.port = port;
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    
    // Session management
    this.sessions = new Map();
    this.clients = new Map();
    this.webClients = new Set();
    
    // Session history (in-memory, could be Redis/DB)
    this.sessionHistory = new Map();
    
    // File browser
    this.fileBrowser = new FileBrowser();
    
    this.setupExpress();
    this.setupWebSocket();
    this.setupFileBrowserRoutes();
  }

  setupExpress() {
    // Serve static files
    this.app.use(express.static('public'));
    this.app.use(express.json());
    
    // API endpoints
    this.app.get('/api/sessions', (req, res) => {
      const sessions = Array.from(this.sessions.values()).map(session => ({
        id: session.id,
        projectName: session.projectName,
        projectPath: session.projectPath,
        hostname: session.hostname,
        platform: session.platform,
        status: session.status,
        connectedAt: session.connectedAt,
        lastActivity: session.lastActivity,
        hasPrompt: session.hasPrompt
      }));
      res.json(sessions);
    });
    
    this.app.get('/api/session/:id', (req, res) => {
      const session = this.sessions.get(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.json(session);
    });
    
    this.app.get('/api/session/:id/history', (req, res) => {
      const history = this.sessionHistory.get(req.params.id) || [];
      res.json(history);
    });
    
    this.app.post('/api/session/:id/input', (req, res) => {
      const { data } = req.body;
      const client = this.clients.get(req.params.id);
      
      if (!client) {
        return res.status(404).json({ error: 'Session not connected' });
      }
      
      // Send input to wrapper
      this.sendToWrapper(client, {
        type: 'input',
        data: data
      });
      
      res.json({ success: true });
    });
    
    this.app.post('/api/session/:id/command', (req, res) => {
      const { command } = req.body;
      const client = this.clients.get(req.params.id);
      
      if (!client) {
        return res.status(404).json({ error: 'Session not connected' });
      }
      
      // Send command to wrapper
      this.sendToWrapper(client, {
        type: 'command',
        command: command
      });
      
      res.json({ success: true });
    });
  }

  setupWebSocket() {
    this.wss.on('connection', (ws, req) => {
      const clientId = uuidv4();
      console.log(`[Server] New connection: ${clientId}`);
      
      // Determine client type from URL or headers
      const isWebClient = req.url === '/web' || req.headers['x-client-type'] === 'web';
      
      if (isWebClient) {
        this.handleWebClient(ws, clientId);
      } else {
        this.handleWrapperClient(ws, clientId);
      }
      
      ws.on('close', () => {
        this.handleDisconnect(clientId, isWebClient);
      });
      
      ws.on('error', (err) => {
        console.error(`[Server] WebSocket error for ${clientId}:`, err.message);
      });
    });
  }

  handleWrapperClient(ws, clientId) {
    console.log(`[Server] Wrapper client connected: ${clientId}`);
    
    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);
        this.handleWrapperMessage(ws, clientId, msg);
      } catch (err) {
        console.error('[Server] Error parsing wrapper message:', err);
      }
    });
  }

  handleWebClient(ws, clientId) {
    console.log(`[Server] Web client connected: ${clientId}`);
    
    this.webClients.add({
      id: clientId,
      ws: ws,
      subscribedSessions: new Set()
    });
    
    // Send initial session list
    ws.send(JSON.stringify({
      type: 'sessions',
      data: Array.from(this.sessions.values())
    }));
    
    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);
        this.handleWebMessage(ws, clientId, msg);
      } catch (err) {
        console.error('[Server] Error parsing web message:', err);
      }
    });
  }

  handleWrapperMessage(ws, clientId, msg) {
    const sessionId = msg.sessionId;
    
    switch (msg.type) {
      case 'register':
        // Register new session
        this.sessions.set(sessionId, {
          id: sessionId,
          clientId: clientId,
          projectName: msg.projectName,
          projectPath: msg.projectPath,
          hostname: msg.hostname,
          platform: msg.platform,
          cols: msg.cols,
          rows: msg.rows,
          status: 'active',
          connectedAt: Date.now(),
          lastActivity: Date.now(),
          hasPrompt: false
        });
        
        this.clients.set(sessionId, ws);
        
        console.log(`[Server] Session registered: ${sessionId} (${msg.projectName})`);
        
        // Notify web clients
        this.broadcastToWeb({
          type: 'session_connected',
          session: this.sessions.get(sessionId)
        });
        break;
        
      case 'output':
        // Store output in history
        this.addToHistory(sessionId, {
          type: 'output',
          data: msg.data,
          timestamp: msg.timestamp
        });
        
        // Update last activity
        const session = this.sessions.get(sessionId);
        if (session) {
          session.lastActivity = Date.now();
        }
        
        // Broadcast to subscribed web clients
        this.broadcastToSubscribers(sessionId, {
          type: 'output',
          sessionId: sessionId,
          data: msg.data,
          timestamp: msg.timestamp
        });
        break;
        
      case 'input':
        // Store input in history
        this.addToHistory(sessionId, {
          type: 'input',
          data: msg.data,
          source: msg.source,
          timestamp: msg.timestamp
        });
        
        // Broadcast to subscribed web clients
        this.broadcastToSubscribers(sessionId, {
          type: 'input',
          sessionId: sessionId,
          data: msg.data,
          source: msg.source,
          timestamp: msg.timestamp
        });
        break;
        
      case 'prompt_detected':
        // Mark session as having a prompt
        const sessionWithPrompt = this.sessions.get(sessionId);
        if (sessionWithPrompt) {
          sessionWithPrompt.hasPrompt = true;
        }
        
        // Notify web clients
        this.broadcastToWeb({
          type: 'prompt_detected',
          sessionId: sessionId,
          data: msg.data,
          timestamp: msg.timestamp
        });
        break;
        
      case 'history':
        // Store historical data
        if (msg.data && Array.isArray(msg.data)) {
          msg.data.forEach(entry => {
            this.addToHistory(sessionId, entry);
          });
        }
        break;
        
      case 'resize':
        // Update terminal size
        const resizedSession = this.sessions.get(sessionId);
        if (resizedSession) {
          resizedSession.cols = msg.cols;
          resizedSession.rows = msg.rows;
          
          console.log(`[Server] Session ${sessionId} resized to ${msg.cols}×${msg.rows}`);
        }
        
        // Broadcast resize to subscribed web clients
        this.broadcastToSubscribers(sessionId, {
          type: 'resize',
          sessionId: sessionId,
          cols: msg.cols,
          rows: msg.rows,
          timestamp: msg.timestamp
        });
        break;
        
      case 'disconnect':
        // Mark session as disconnected
        const disconnectedSession = this.sessions.get(sessionId);
        if (disconnectedSession) {
          disconnectedSession.status = 'disconnected';
        }
        break;
        
      case 'pong':
        // Update last activity on pong
        const pongedSession = this.sessions.get(sessionId);
        if (pongedSession) {
          pongedSession.lastActivity = Date.now();
        }
        break;
    }
  }

  handleWebMessage(ws, clientId, msg) {
    const webClient = Array.from(this.webClients).find(c => c.id === clientId);
    if (!webClient) return;
    
    switch (msg.type) {
      case 'subscribe':
        // Subscribe to session updates
        if (msg.sessionId) {
          webClient.subscribedSessions.add(msg.sessionId);
          
          // Send current history
          const history = this.sessionHistory.get(msg.sessionId) || [];
          ws.send(JSON.stringify({
            type: 'history',
            sessionId: msg.sessionId,
            data: history
          }));
        }
        break;
        
      case 'unsubscribe':
        // Unsubscribe from session
        if (msg.sessionId) {
          webClient.subscribedSessions.delete(msg.sessionId);
        }
        break;
        
      case 'input':
        // Forward input to wrapper
        if (msg.sessionId) {
          const wrapperClient = this.clients.get(msg.sessionId);
          if (wrapperClient) {
            this.sendToWrapper(wrapperClient, {
              type: 'input',
              data: msg.data
            });
          }
        }
        break;
        
      case 'command':
        // Forward command to wrapper
        if (msg.sessionId) {
          const wrapperClient = this.clients.get(msg.sessionId);
          if (wrapperClient) {
            this.sendToWrapper(wrapperClient, {
              type: 'command',
              command: msg.command
            });
          }
        }
        break;
    }
  }

  handleDisconnect(clientId, isWebClient) {
    if (isWebClient) {
      // Remove web client
      this.webClients = new Set(
        Array.from(this.webClients).filter(c => c.id !== clientId)
      );
      console.log(`[Server] Web client disconnected: ${clientId}`);
    } else {
      // Find and update session status
      for (const [sessionId, session] of this.sessions) {
        if (session.clientId === clientId) {
          session.status = 'disconnected';
          this.clients.delete(sessionId);
          
          console.log(`[Server] Wrapper disconnected: ${sessionId}`);
          
          // Notify web clients
          this.broadcastToWeb({
            type: 'session_disconnected',
            sessionId: sessionId
          });
          break;
        }
      }
    }
  }

  sendToWrapper(ws, message) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  broadcastToWeb(message) {
    this.webClients.forEach(client => {
      if (client.ws.readyState === client.ws.OPEN) {
        client.ws.send(JSON.stringify(message));
      }
    });
  }

  broadcastToSubscribers(sessionId, message) {
    this.webClients.forEach(client => {
      if (client.subscribedSessions.has(sessionId) && 
          client.ws.readyState === client.ws.OPEN) {
        client.ws.send(JSON.stringify(message));
      }
    });
  }

  addToHistory(sessionId, entry) {
    if (!this.sessionHistory.has(sessionId)) {
      this.sessionHistory.set(sessionId, []);
    }
    
    const history = this.sessionHistory.get(sessionId);
    history.push(entry);
    
    // Limit history size (keep last 10000 entries)
    if (history.length > 10000) {
      history.shift();
    }
  }

  setupFileBrowserRoutes() {
    // Get directory tree for a path (no session required)
    this.app.get('/api/files', async (req, res) => {
      const directoryPath = req.query.path;
      if (!directoryPath) {
        return res.status(400).json({ error: 'Directory path required' });
      }
      
      const tree = await this.fileBrowser.getDirectoryTree(
        directoryPath,
        req.query.depth || 3
      );
      
      res.json(tree);
    });
    
    // Get file content (no session required)
    this.app.get('/api/file', async (req, res) => {
      const filePath = req.query.path;
      if (!filePath) {
        return res.status(400).json({ error: 'File path required' });
      }
      
      const content = await this.fileBrowser.getFileContent(filePath);
      res.json(content);
    });
    
    // Legacy session-based routes for backward compatibility
    this.app.get('/api/session/:id/files', async (req, res) => {
      const session = this.sessions.get(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      const tree = await this.fileBrowser.getDirectoryTree(
        session.projectPath,
        req.query.depth || 3
      );
      
      res.json(tree);
    });
    
    this.app.get('/api/session/:id/file', async (req, res) => {
      const session = this.sessions.get(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      const filePath = req.query.path;
      if (!filePath) {
        return res.status(400).json({ error: 'File path required' });
      }
      
      // Security: ensure file is within project directory
      const resolvedPath = path.resolve(session.projectPath, filePath);
      if (!resolvedPath.startsWith(path.resolve(session.projectPath))) {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      const content = await this.fileBrowser.getFileContent(resolvedPath);
      res.json(content);
    });
    
    // Get git status (no session required)
    this.app.get('/api/git-status', async (req, res) => {
      const directoryPath = req.query.path;
      if (!directoryPath) {
        return res.status(400).json({ error: 'Directory path required' });
      }
      
      const status = await this.fileBrowser.getGitStatus(directoryPath);
      res.json(status);
    });
    
    // Get recently modified files (no session required)
    this.app.get('/api/recent-files', async (req, res) => {
      const directoryPath = req.query.path;
      if (!directoryPath) {
        return res.status(400).json({ error: 'Directory path required' });
      }
      
      const recent = await this.fileBrowser.getRecentlyModified(
        directoryPath,
        req.query.limit || 10
      );
      res.json(recent);
    });
    
    // Legacy session-based routes
    this.app.get('/api/session/:id/git-status', async (req, res) => {
      const session = this.sessions.get(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      const status = await this.fileBrowser.getGitStatus(session.projectPath);
      res.json(status);
    });
    
    this.app.get('/api/session/:id/recent-files', async (req, res) => {
      const session = this.sessions.get(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      const recent = await this.fileBrowser.getRecentlyModified(
        session.projectPath,
        req.query.limit || 10
      );
      res.json(recent);
    });
  }

  start() {
    this.server.listen(this.port, () => {
      console.log(`[Server] Shellstream Server running on http://localhost:${this.port}`);
      console.log(`[Server] WebSocket endpoint: ws://localhost:${this.port}`);
      console.log(`[Server] Web UI: http://localhost:${this.port}`);
    });
    
    // Periodic health check for sessions
    setInterval(() => {
      this.sessions.forEach((session, sessionId) => {
        const client = this.clients.get(sessionId);
        if (client && client.readyState === client.OPEN) {
          client.send(JSON.stringify({ type: 'ping' }));
        }
      });
    }, 30000);
  }
}

// FileBrowser class for handling file operations
class FileBrowser {
  constructor() {
    this.allowedExtensions = new Set([
      '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.txt', '.yaml', '.yml',
      '.html', '.css', '.scss', '.py', '.java', '.go', '.rs', '.cpp', '.c',
      '.h', '.hpp', '.cs', '.rb', '.php', '.sh', '.bash', '.env', '.config',
      '.xml', '.toml', '.ini', '.cfg', '.conf', '.log', '.sql', '.dockerfile',
      '.gitignore', '.editorconfig', '.prettierrc', '.eslintrc'
    ]);
    
    this.maxFileSize = 1024 * 1024; // 1MB max for viewing
  }

  async getDirectoryTree(dirPath, maxDepth = 3, currentDepth = 0) {
    if (currentDepth >= maxDepth) return null;
    
    try {
      const stats = await fs.stat(dirPath);
      const name = path.basename(dirPath);
      
      if (!stats.isDirectory()) {
        return {
          name,
          type: 'file',
          path: dirPath,
          size: stats.size,
          modified: stats.mtime,
          extension: path.extname(name).toLowerCase()
        };
      }
      
      const files = await fs.readdir(dirPath);
      const children = [];
      
      // Filter and sort
      const filtered = files
        .filter(f => !f.startsWith('.') || f === '.env' || f === '.gitignore')
        .sort((a, b) => {
          // Directories first, then files
          const aPath = path.join(dirPath, a);
          const bPath = path.join(dirPath, b);
          try {
            const aStat = require('fs').statSync(aPath);
            const bStat = require('fs').statSync(bPath);
            if (aStat.isDirectory() && !bStat.isDirectory()) return -1;
            if (!aStat.isDirectory() && bStat.isDirectory()) return 1;
            return a.localeCompare(b);
          } catch {
            return 0;
          }
        });
      
      // Process children
      for (const file of filtered.slice(0, 100)) { // Limit to 100 items
        const filePath = path.join(dirPath, file);
        try {
          const child = await this.getDirectoryTree(filePath, maxDepth, currentDepth + 1);
          if (child) children.push(child);
        } catch (err) {
          // Skip inaccessible files
        }
      }
      
      return {
        name,
        type: 'directory',
        path: dirPath,
        children,
        modified: stats.mtime
      };
    } catch (err) {
      return null;
    }
  }

  async getFileContent(filePath) {
    try {
      const stats = await fs.stat(filePath);
      
      // Check file size
      if (stats.size > this.maxFileSize) {
        return {
          error: 'File too large',
          size: stats.size
        };
      }
      
      // Check if it's a text file we can display
      const ext = path.extname(filePath).toLowerCase();
      if (!this.allowedExtensions.has(ext) && ext !== '') {
        // Try to detect if it's text
        const buffer = await fs.readFile(filePath, { encoding: null });
        const isText = this.isText(buffer);
        
        if (!isText) {
          return {
            error: 'Binary file',
            type: 'binary'
          };
        }
      }
      
      const content = await fs.readFile(filePath, 'utf8');
      return {
        content,
        language: this.detectLanguage(filePath),
        size: stats.size,
        modified: stats.mtime
      };
    } catch (err) {
      return {
        error: err.message
      };
    }
  }

  async getGitStatus(projectPath) {
    try {
      const { stdout } = await execPromise('git status --porcelain', {
        cwd: projectPath
      });
      
      const files = stdout.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const status = line.substring(0, 2);
          const file = line.substring(3);
          return {
            file,
            status: this.parseGitStatus(status)
          };
        });
      
      return { files };
    } catch (err) {
      return { error: 'Not a git repository' };
    }
  }

  async getRecentlyModified(projectPath, limit = 10) {
    try {
      const { stdout } = await execPromise(
        `find . -type f -name "*.js" -o -name "*.ts" -o -name "*.jsx" -o -name "*.tsx" -o -name "*.py" -o -name "*.java" 2>/dev/null | head -20 | xargs ls -lt 2>/dev/null | head -${limit}`,
        { cwd: projectPath, shell: true }
      );
      
      const files = stdout.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const parts = line.split(/\s+/);
          if (parts.length >= 9) {
            const filePath = parts.slice(8).join(' ');
            return {
              path: filePath,
              modified: parts.slice(5, 8).join(' ')
            };
          }
          return null;
        })
        .filter(f => f !== null);
      
      return { files };
    } catch {
      return { files: [] };
    }
  }

  parseGitStatus(status) {
    const statusMap = {
      'M ': 'modified',
      'MM': 'modified',
      'A ': 'added',
      'D ': 'deleted',
      '??': 'untracked',
      'R ': 'renamed',
      'C ': 'copied'
    };
    return statusMap[status] || 'unknown';
  }

  detectLanguage(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const languageMap = {
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.py': 'python',
      '.java': 'java',
      '.go': 'go',
      '.rs': 'rust',
      '.cpp': 'cpp',
      '.c': 'c',
      '.cs': 'csharp',
      '.rb': 'ruby',
      '.php': 'php',
      '.html': 'html',
      '.css': 'css',
      '.scss': 'scss',
      '.json': 'json',
      '.xml': 'xml',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.md': 'markdown',
      '.sh': 'bash',
      '.sql': 'sql'
    };
    return languageMap[ext] || 'plaintext';
  }

  isText(buffer) {
    // Simple text detection
    for (let i = 0; i < Math.min(buffer.length, 8000); i++) {
      const byte = buffer[i];
      if (byte === 0) return false; // Null byte = binary
      if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
        return false; // Control character (except tab, LF, CR)
      }
    }
    return true;
  }
}

// Start server
if (require.main === module) {
  const port = process.env.PORT || 47832;
  const server = new ShellstreamServer(port);
  server.start();
}

module.exports = ShellstreamServer;
