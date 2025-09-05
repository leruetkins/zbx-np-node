const { app, BrowserWindow, Tray, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow = null;
let tray = null;
let windowState = null;
const windowStateFileName = 'window-state.json';
const userDataPath = app.getPath('userData');
const windowStatePath = path.join(userDataPath, windowStateFileName);

function saveWindowState() {
  if (!mainWindow) {
    return;
  }
  let currentBounds = mainWindow.getBounds();
  let isMaximized = mainWindow.isMaximized();
  let isFullScreen = mainWindow.isFullScreen();

  // If window is maximized or full screen, get its normal bounds
  if (isMaximized || isFullScreen) {
    currentBounds = mainWindow.getNormalBounds();
  }

  windowState = { ...currentBounds, isMaximized, isFullScreen };
  try {
    // Ensure the directory exists
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(windowStatePath, JSON.stringify(windowState));
  } catch (e) {
    console.error("Failed to save window state:", e);
  }
}

function restoreWindowState() {
  try {
    const data = fs.readFileSync(windowStatePath, 'utf8');
    windowState = JSON.parse(data);
    // Validate the loaded state
    if (windowState &&
        typeof windowState.x === 'number' &&
        typeof windowState.y === 'number' &&
        typeof windowState.width === 'number' &&
        typeof windowState.height === 'number' &&
        typeof windowState.isMaximized === 'boolean' &&
        typeof windowState.isFullScreen === 'boolean') {
      return windowState;
    }
  } catch (e) {
    // File doesn't exist, is empty, or corrupted
    console.warn("Failed to load window state, using defaults:", e);
  }
  // Default state
  return {
    width: 1000,
    height: 800,
    x: undefined, // Let Electron position it
    y: undefined, // Let Electron position it
    isMaximized: false,
    isFullScreen: false
  };
}

function createWindow(url) {
  const state = restoreWindowState();

  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: false, // Don't show the window until it's ready
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'electron-preload.js')
    },
    icon: path.join(__dirname, 'icon.png')
  });

  if (state.isMaximized) {
    mainWindow.maximize();
  }
  if (state.isFullScreen) {
    mainWindow.setFullScreen(true);
  }

  mainWindow.loadURL(url);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', function (event) {
    if (!app.isQuitting) {
      event.preventDefault();
      saveWindowState(); // Save state before hiding
      mainWindow.hide();
    }
    return false;
  });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

async function startApp() {
  // Start the Express server from src/app.js
  const appModule = require('./src/app');
  // startServer should return the port used
  const port = await appModule.startServer();

  const url = `http://localhost:${port}/console`;

  createWindow(url);
}

app.on('ready', () => {
  startApp().then(() => {
    tray = new Tray(path.join(__dirname, 'icon.png'));
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Открыть',
        click: function () {
          mainWindow.show();
        },
      },
      {
        label: 'Выйти',
        click: function () {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setToolTip('Zabbix NP Node');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        mainWindow.show();
    });
  });
});

app.on('window-all-closed', function () {
  // On macOS it is common for applications to stay open until the user quits explicitly
  if (process.platform !== 'darwin') {
    // app.quit(); // We don't want to quit here anymore
  }
});

app.on('before-quit', () => {
  saveWindowState();
});

app.on('activate', function () {
  if (mainWindow === null) {
      startApp();
  } else {
      mainWindow.show();
  }
});
