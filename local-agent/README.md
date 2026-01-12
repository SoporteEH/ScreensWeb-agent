# ScreensWeb Agent

Desktop application for Windows-based digital signage systems. Connects to the ScreensWeb central platform via WebSockets and manages content display across multiple physical screens.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Development](#development)
- [Build and Distribution](#build-and-distribution)
- [Auto-Update System](#auto-update-system)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)

## Overview

The ScreensWeb Agent is installed on venue PCs to display dynamic content on one or more screens. It maintains a persistent WebSocket connection to the central platform and executes remote commands in real-time.

**Core Responsibilities:**
- Establish and maintain WebSocket connection to ScreensWeb backend
- Receive and execute commands (display URL, show local assets, close content, identify screens)
- Detect and manage multiple physical displays
- Display content in full-screen kiosk mode
- Handle connection failures with automatic reconnection
- Auto-update from GitHub Releases using electron-updater

## Features

**Multi-Monitor Support**
- Automatic detection of physical displays
- Predictable screen IDs (1, 2, 3) ordered left-to-right
- Independent content management per screen
- Position-based state persistence

**Connectivity**
- WebSocket connection with automatic reconnection
- Offline operation with fallback content
- Network monitoring and recovery
- Centralized error logging to backend

**Auto-Update**
- CI/CD integration with GitHub Actions
- Silent installation of updates
- Version rollback support
- Zero-downtime updates

**Security**
- Encrypted configuration storage using electron-store
- JWT-based authentication
- Command validation with Zod schemas
- Secure token refresh mechanism

**Asset Management**
- Local asset synchronization from central platform
- Offline content playback capability
- Automatic cleanup of obsolete files

## Architecture

```
┌─────────────────────────────┐
│  ScreensWeb Backend         │
│  (API + Socket.IO Server)   │
└──────────────┬──────────────┘
               │ WebSocket (WSS/WS)
┌──────────────▼──────────────┐
│     ScreensWeb Agent        │
│     (Electron App)          │
├─────────────────────────────┤
│  Main Process               │
│  - Connection Management    │
│  - Command Handling         │
│  - State Persistence        │
├─────────────────────────────┤
│  Renderer Processes         │
│  - Content Windows          │
│  - Identify Overlay         │
│  - Provisioning UI          │
└──────────────┬──────────────┘
               │ Display Output
┌──────────────▼──────────────┐
│    Physical Monitors        │
└─────────────────────────────┘
```

## Technology Stack

**Core:**
- Electron 38.x
- Node.js 18+
- Socket.IO Client 4.x

**Build & Distribution:**
- electron-builder 24.x
- electron-updater 6.x
- GitHub Actions

**Storage & Security:**
- electron-store 8.1.0 (CommonJS compatible)
- JWT authentication
- Zod schema validation

**Development:**
- electron-log for logging
- dotenv for environment configuration

## Requirements

**Production (End User):**
- Windows 10/11 (64-bit)
- Network connectivity to ScreensWeb backend

**Development:**
- Windows 10/11
- Node.js 18+
- npm 9+
- Git

## Installation

### Development Setup

```bash
git clone <repository-url>
cd ScreensWeb-agent/local-agent
npm install
```

### Production Installation

Download the latest `.exe` installer from GitHub Releases and run it. The agent will:
1. Install to `Program Files/ScreensWeb Agent`
2. Create desktop shortcut
3. Configure auto-start with Windows
4. Launch provisioning mode on first run

## Configuration

The agent requires the backend server URL for operation.

### Development Configuration

Create a `.env` file in the `local-agent` directory:

```env
SERVER_URL=http://localhost:3000
```

### Production Configuration

For production builds, the `SERVER_URL` is injected during the build process via `package.json` `extraMetadata` or GitHub Secrets.

### Configuration Storage

The agent stores its configuration in `electron-store`:
- **Location:** `%APPDATA%\local-agent\ScreensWeb\config.json`
- **Content:** `deviceId`, `agentToken` (encrypted)
- **Reset:** Delete this file to return to provisioning mode

## Development

Start the agent in development mode:

```bash
npm start
```

**Expected Behavior:**
- **First Run:** Launches in Provisioning Mode, displays device ID for linking
- **Configured:** Launches in Normal Mode, connects to backend automatically

**Development Tools:**
- DevTools enabled in development mode
- Hot reload not supported (requires app restart)
- Logs written to console and file (`%APPDATA%\local-agent\ScreensWeb\logs\`)

## Build and Distribution

Generate the Windows installer:

```bash
npm run build
```

**Output:**
- `dist/ScreensWebAgent-Setup-1.x.x.exe` - NSIS installer
- `dist/latest.yml` - Update metadata for electron-updater
- `dist/win-unpacked/` - Unpacked application files

## Auto-Update System

The agent uses `electron-updater` for seamless updates.

### Release Process (Developer)

1. Update version in `package.json`:
   ```json
   {
     "version": "1.0.2"
   }
   ```

2. Commit and create a git tag:
   ```bash
   git add package.json
   git commit -m "Bump version to 1.0.2"
   git tag v1.0.2
   git push origin main --tags
   ```

3. GitHub Actions automatically:
   - Builds the application
   - Generates installer and `latest.yml`
   - Creates a GitHub Release with artifacts

### Update Process (Agent)

1. Agent checks for updates periodically (configurable interval)
2. Detects new version from `latest.yml`
3. Downloads installer in background
4. Prompts user or auto-installs (configurable)
5. Restarts with new version

**Configuration:**
- Check interval: 4 hours (default)
- Silent mode: enabled for production
- Rollback: manual via GitHub Release

## Project Structure

```
local-agent/
├── config/
│   └── constants.js           # Centralized configuration (URLs, timeouts, paths)
├── handlers/
│   ├── commands.js            # Remote command handlers (show_url, close_screen, etc.)
│   └── provisioning.js        # Device provisioning flow
├── services/
│   ├── assets.js              # Local asset synchronization
│   ├── auth.js                # JWT token refresh
│   ├── device.js              # Device registration and system commands
│   ├── gpu.js                 # GPU configuration and crash handling
│   ├── network.js             # Network connectivity monitoring
│   ├── socket.js              # WebSocket connection management
│   ├── state.js               # Screen state persistence
│   ├── tray.js                # System tray icon and menu
│   └── updater.js             # Auto-update orchestration
├── utils/
│   ├── configManager.js       # Configuration file management
│   └── logConfig.js           # Logging configuration
├── icons/                     # Application icons
├── main.js                    # Main process orchestrator
├── preload.js                 # Preload script for renderer security
├── identify-preload.js        # Preload for screen identification
├── control.html               # Control panel UI
├── fallback.html              # Offline fallback page
├── identify.html              # Screen identification overlay
├── provision.html             # Provisioning mode UI
├── package.json               # Project metadata and Electron config
└── README.md                  # This file
```

### Architecture Layers

| Layer | Responsibility |
|-------|----------------|
| **main.js** | Application orchestration, event coordination |
| **services/** | Independent modules with single responsibility |
| **handlers/** | Command execution and user flows |
| **config/** | Centralized constants and configuration |
| **utils/** | Reusable utilities |

## License

##### Proprietary - All rights reserved
