# CLAUDE.md - Shellcast Project Context

## 🎯 Project Intent

**Shellcast** is a universal terminal session broadcaster that allows monitoring and controlling any command-line program from a web browser. Born from the need to monitor Claude CLI sessions remotely, it evolved into a general-purpose tool for broadcasting ANY terminal session to the web.

### Original Problem
- User wanted to monitor Claude CLI sessions running in IntelliJ from their phone
- Needed to see both terminal output AND files being created/modified
- Required ability to approve prompts remotely
- Wanted to keep existing workflow (IntelliJ) unchanged

### Evolution
The project evolved from "Claude monitor" → "Universal terminal broadcaster" when we realized the architecture works for ANY terminal program, not just Claude.

## 🏗️ Architecture Overview

```
Terminal Program (any CLI tool)
        ↓
    shellcast.js (PTY wrapper)
        ├── Captures all I/O via node-pty
        ├── Auto-starts server if needed
        ├── Transparent passthrough to local terminal
        └── Broadcasts to server via WebSocket
              ↓
    server.js (Central hub)
        ├── Manages multiple sessions
        ├── Stores session history
        ├── Handles WebSocket connections
        ├── Serves web UI
        └── File browser API endpoints
              ↓
    public/index.html (Web UI)
        ├── xterm.js for terminal emulation
        ├── File tree browser
        ├── Git status viewer
        └── Remote control buttons
```

## 🔑 Key Design Decisions

### 1. **Transparent Wrapper Pattern**
- The wrapper uses `node-pty` to create a pseudo-terminal
- ALL programs work unchanged - they think they're in a real terminal
- Local terminal continues working exactly as normal
- Remote monitoring is an ADD-ON, not a REPLACEMENT

### 2. **Auto-Starting Server**
- Server is NOT a child process (survives wrapper exit)
- Starts automatically when first wrapper runs
- Persists across sessions
- Multiple wrappers share one server

### 3. **Session-Based Architecture**
- Each wrapped program gets a unique session ID
- Sessions persist even if wrapper disconnects
- Can reconnect to sessions from anywhere
- Multiple viewers can watch same session

### 4. **WebSocket for Real-time**
- Binary-safe transmission of terminal output
- Handles ANSI escape codes properly
- Resize events synchronized
- Bidirectional communication for remote input

### 5. **xterm.js for Perfect Emulation**
- Not just text display - full terminal emulation
- Handles colors, cursor positioning, control codes
- Enables vim, nano, htop to work properly
- Maintains exact dimensions from source terminal

## 📂 File Structure Explained

```
shellcast/
├── shellcast.js          # The magic happens here - PTY wrapper
│                        # Spawns any program in a pseudo-terminal
│                        # Captures ALL output (including ANSI codes)
│                        # Auto-starts server, connects via WebSocket
│
├── server.js            # Central nervous system
│                        # WebSocket server for real-time communication
│                        # Express server for web UI and API
│                        # Session management (tracks all active sessions)
│                        # File browser API (reads project directories)
│
├── server-manager.js    # Utility for controlling the server
│                        # Start/stop/restart/status commands
│                        # PID management
│                        # Log management
│
├── public/
│   └── index.html       # Single-page web application
│                        # xterm.js for terminal rendering
│                        # WebSocket client for real-time updates
│                        # File browser with syntax highlighting
│                        # Git status display
│
├── package.json         # Dependencies:
│                        # - node-pty (pseudo-terminal creation)
│                        # - ws (WebSocket server)
│                        # - express (web server)
│                        # - uuid (session IDs)
│
├── setup.sh            # Installation helper
│                        # Creates shell aliases
│                        # Sets up environment variables
│
└── README.md           # User-facing documentation
```

## 🔄 Data Flow

### Starting a Session
1. User runs: `shellcast npm start`
2. Wrapper checks if server is running (port 3001)
3. If not, starts server as detached process
4. Wrapper spawns `npm start` in a PTY
5. Wrapper connects to server via WebSocket
6. Registers session with metadata (ID, command, path, dimensions)
7. Server notifies all web clients of new session

### Output Flow
1. Program writes to stdout/stderr
2. PTY captures output (including ANSI codes)
3. Wrapper receives via `ptyProcess.onData()`
4. Wrapper sends to server via WebSocket
5. Server broadcasts to subscribed web clients
6. Web clients render in xterm.js terminal

### Input Flow (Remote Control)
1. User clicks "Approve" in web UI
2. Web client sends command via WebSocket
3. Server routes to appropriate wrapper
4. Wrapper writes to PTY stdin
5. Program receives input as if typed locally

### Resize Flow
1. Terminal window resizes (e.g., IntelliJ pane)
2. Wrapper detects via `process.stdout.on('resize')`
3. Wrapper resizes PTY to match
4. Wrapper notifies server of new dimensions
5. Server broadcasts resize to web clients
6. xterm.js terminals resize to match

## 🚀 Development Roadmap

### Immediate Improvements
```javascript
// 1. Add authentication to server
// Currently no auth - anyone on network can view
// Add basic auth or token-based auth

// 2. Persistent session history
// Currently in-memory only
// Add SQLite or file-based storage

// 3. Session recording/playback
// Store terminal sessions for later replay
// Could use asciinema format

// 4. Better error handling
// Graceful degradation if server unreachable
// Reconnection with exponential backoff
```

### Medium-term Features
```javascript
// 1. Configuration file support
// ~/.shellcastrc for default settings
// Per-project .shellcast.json

// 2. Filtering/search in terminal output
// Ctrl+F style search in xterm.js
// Regex pattern matching

// 3. Multiple terminal tabs
// Like tmux/screen but in browser
// Split panes support

// 4. Collaborative features
// Multiple users can control same session
// Cursor sharing/highlighting

// 5. Plugin system
// Hooks for custom processors
// Integration with CI/CD tools
```

### Long-term Vision
```javascript
// 1. Cloud-hosted version
// Run shellcast.io service
// Public/private session sharing

// 2. Mobile apps
// Native iOS/Android apps
// Better touch controls

// 3. VS Code extension
// Start shellcast from VS Code
// Integrated terminal broadcaster

// 4. AI integration
// Auto-detect errors and suggest fixes
// Command completion/suggestions

// 5. Enterprise features
// Audit logging
// Role-based access control
// SSO integration
```

## 🐛 Known Issues & TODOs

### Critical
- [ ] No authentication - security risk for network exposure
- [ ] Server doesn't clean up disconnected sessions
- [ ] Large output can overflow memory (no streaming limits)

### Important
- [ ] File browser can't handle large directories (>1000 files)
- [ ] Binary files detection is primitive
- [ ] Git status doesn't work with submodules
- [ ] No Windows native support (works in WSL)

### Nice to Have
- [ ] Customizable terminal themes
- [ ] Keyboard shortcuts in web UI
- [ ] Download session as text file
- [ ] Share session via public URL
- [ ] Terminal replay speed control

## 🔧 Code Patterns to Follow

### Adding New Remote Commands
```javascript
// In shellcast.js - executeRemoteCommand()
case 'your-command':
  if (this.ptyProcess) {
    this.ptyProcess.write('your-input\n');
    console.error('[Shellcast] Your command executed');
  }
  break;
```

### Adding New API Endpoints
```javascript
// In server.js - setupExpress()
this.app.get('/api/session/:id/your-endpoint', async (req, res) => {
  const session = this.sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  // Your logic here
  res.json({ your: 'data' });
});
```

### Adding Pattern Detection
```javascript
// In shellcast.js - constructor patterns object
yourPattern: [
  /pattern1/i,
  /pattern2/i
]

// In detectPatterns()
const hasYourPattern = this.patterns.yourPattern.some(pattern => pattern.test(text));
if (hasYourPattern && this.connected) {
  this.sendToServer({
    type: 'your_pattern_detected',
    data: text,
    timestamp: Date.now()
  });
}
```

## 💡 Key Insights for Development

### Why node-pty?
- Creates a REAL pseudo-terminal, not just pipes
- Programs behave exactly as in a real terminal
- Handles ALL terminal features (colors, cursor, etc.)
- Cross-platform (Linux, macOS, Windows via ConPTY)

### Why WebSockets?
- Real-time bidirectional communication
- Binary safe (terminal output contains binary data)
- Low latency
- Handles reconnection gracefully

### Why xterm.js?
- Full terminal emulation in browser
- Handles ANSI escape sequences
- Supports resize events
- Addons for links, search, etc.

### Why separate server process?
- Survives wrapper crashes
- Multiple wrappers share one server
- Can stop wrapper without losing server
- Better resource management

## 🎯 Success Metrics

The project succeeds when:
1. **Any CLI program** can be monitored remotely
2. **Zero changes** required to existing workflow
3. **Mobile-friendly** interface that actually works
4. **Real-time** with no noticeable lag
5. **Secure enough** for development use
6. **Simple enough** that setup takes < 1 minute

## 🤝 Contributing Guidelines

When adding features:
1. **Maintain transparency** - Local terminal must work unchanged
2. **Preserve compatibility** - Don't break existing sessions
3. **Think mobile-first** - Features must work on phones
4. **Keep it lightweight** - This isn't meant to be VS Code
5. **Document patterns** - Update this file with new patterns

## 📚 Technical Debts

1. **Memory management** - Output buffers grow unbounded
2. **Error handling** - Many edge cases not handled
3. **Testing** - No test suite currently
4. **TypeScript** - Would benefit from type safety
5. **Logging** - Need structured logging (not console.error)

## 🔮 Why This Matters

Shellcast solves a real problem developers have:
- Running long processes that need monitoring
- Debugging on remote machines
- Teaching/demonstrating command-line tools
- Collaborating on terminal sessions
- Monitoring CI/CD pipelines

It's the modern answer to GNU Screen/tmux - but with a web UI that works everywhere.

## 🚦 Quick Start for New Developers

```bash
# 1. Understand the core loop
# Terminal → PTY → Wrapper → Server → Browser

# 2. Start with the wrapper
# shellcast.js is where the magic happens

# 3. Test with simple commands first
node shellcast.js echo "hello"
node shellcast.js ls -la

# 4. Then try interactive programs
node shellcast.js python
node shellcast.js vim test.txt

# 5. Open browser console
# Watch WebSocket messages to understand protocol

# 6. Modify and test
# The architecture is forgiving - just restart
```

## 📞 Contact & Context

This project was created in a conversation about monitoring Claude CLI sessions but evolved into something bigger. The name "Shellcast" was chosen because it clearly conveys "broadcasting shell sessions."

The architecture is intentionally simple:
- **One wrapper file** (could be rewritten in Go for distribution)
- **One server file** (could add Redis for scale)
- **One HTML file** (could become a React app)

But simplicity is a feature, not a limitation. This could genuinely become a popular developer tool.

---

*"Because your terminal sessions deserve a broadcast"*
