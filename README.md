# 🚀 Shellstream

Stream any terminal session to the web in real-time. Monitor and control remote processes from anywhere using just a browser.

[![npm version](https://badge.fury.io/js/%40daviddawson%2Fshellstream.svg)](https://www.npmjs.com/package/@daviddawson/shellstream)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ✨ Features

- **Universal Compatibility** - Works with ANY command-line program (bash, vim, htop, docker, etc.)
- **Real-time Streaming** - Watch terminal output in real-time through your browser
- **Remote Control** - Send input to running processes from the web interface
- **Mobile Friendly** - Responsive design works great on phones and tablets
- **File Browser** - Browse and view project files alongside terminal output
- **Session Management** - Multiple concurrent sessions with automatic grouping by directory
- **Zero Configuration** - Works out of the box with automatic server management
- **Transparent Wrapper** - Your terminal works exactly as normal while being streamed

## 📦 Installation

```bash
npm install -g @daviddawson/shellstream
```

Or use directly with npx:
```bash
npx @daviddawson/shellstream <command>
```

## 🚀 Quick Start

### Stream a command
```bash
# Stream any command to the web
shellstream npm start
shellstream python app.py
shellstream docker logs -f mycontainer

# Or use the short alias
ss npm test
```

### Open the web interface
Navigate to http://localhost:47832 in your browser

### Interactive sessions
```bash
# Start an interactive bash session
shellstream bash

# Monitor a development server
shellstream npm run dev

# Stream a Python REPL
shellstream python
```

## 🎯 Use Cases

- **Remote Monitoring** - Watch long-running processes from your phone
- **Team Collaboration** - Share terminal sessions with teammates  
- **Teaching & Demos** - Stream coding sessions for educational purposes
- **DevOps & Debugging** - Monitor deployments and debug issues remotely
- **CI/CD Pipelines** - Watch build and test output in real-time

## 🔧 How It Works

Shellstream uses a transparent wrapper pattern:

1. **Wrapper Process** - Spawns your command in a pseudo-terminal (PTY)
2. **Auto-starting Server** - Automatically starts a local web server if needed
3. **WebSocket Streaming** - Streams all terminal I/O through WebSockets
4. **Web Interface** - Renders the terminal using xterm.js with full ANSI support

Your local terminal continues to work exactly as normal - Shellstream just broadcasts a copy to the web.

## 📱 Mobile Support

The web interface is fully responsive with:
- Touch-friendly controls
- Horizontal scrolling for wide terminal output
- Collapsible sidebar for maximum screen space
- Gesture support for navigation

## 🛠️ Advanced Usage

### Server Management

```bash
# Check server status
shellstream --status

# Stop the server
shellstream --stop

# Restart the server  
shellstream --restart

# View server logs
shellstream --logs
```

### Custom Port

```bash
# Use a custom port
SHELLSTREAM_PORT=8080 shellstream npm start
```

### File Browser

The web interface includes a built-in file browser that lets you:
- Browse the project directory structure
- View source code with syntax highlighting
- See git status for modified files
- Navigate between multiple terminal sessions

## 🔒 Security

⚠️ **Important**: Shellstream is designed for local development use. The web interface has no authentication by default. 

For remote access, use SSH tunneling:
```bash
ssh -L 47832:localhost:47832 user@remote-host
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built with [node-pty](https://github.com/microsoft/node-pty) for pseudo-terminal support
- Uses [xterm.js](https://github.com/xtermjs/xterm.js) for terminal rendering
- Inspired by tools like tmux, screen, and ttyd

## 🐛 Known Issues

- Firefox mobile may experience input duplication (workaround implemented)
- Some complex ncurses applications may not render perfectly
- Windows support requires Windows Terminal or WSL

## 📧 Contact

- GitHub: [@daviddawson](https://github.com/daviddawson)
- Issues: [GitHub Issues](https://github.com/daviddawson/shellstream/issues)

---

Made with ❤️ for developers who need to monitor their terminals from anywhere