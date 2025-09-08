const { app, BrowserWindow, Tray, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

// ┌──────────────────────────────────────────────────────────┐
// │ ✅ ПЕРЕОПРЕДЕЛЕНИЕ userData — ДО app.on('ready')           │
// │ Сохраняем данные рядом с AppImage или исполняемым файлом  │
// └──────────────────────────────────────────────────────────┘

const getAppImagePath = () => {
  // Если запущено из AppImage — возвращаем путь к самому файлу .AppImage
  if (process.env.APPIMAGE) {
    return process.env.APPIMAGE;
  }
  // Для dev-режима или linux-unpacked
  return process.execPath;
};

const appImagePath = getAppImagePath();
const appImageDir = path.dirname(appImagePath);
const portableDataPath = path.join(appImageDir, 'data');

try {
  if (!fs.existsSync(portableDataPath)) {
    fs.mkdirSync(portableDataPath, { recursive: true });
  }
  app.setPath('userData', portableDataPath);
  console.log('[INFO] Portable data directory set to:', portableDataPath);
} catch (e) {
  console.warn('[WARN] Failed to set portable data directory. Falling back to default userData path.', e);
  // Если не удалось — оставляем стандартный путь (~/.config/...)
  // Приложение продолжит работу, но данные будут в домашней папке
}

// ┌──────────────────────────────────────────────────────────┐
// │ Основная логика приложения                                │
// └──────────────────────────────────────────────────────────┘

let mainWindow = null;
let tray = null;
let windowState = null;
const windowStateFileName = 'window-state.json';
const userDataPath = app.getPath('userData'); // ← Теперь это либо ./data, либо ~/.config/...
const windowStatePath = path.join(userDataPath, windowStateFileName);

function saveWindowState() {
  if (!mainWindow) {
    return;
  }
  let currentBounds = mainWindow.getBounds();
  let isMaximized = mainWindow.isMaximized();
  let isFullScreen = mainWindow.isFullScreen();

  // Если окно развёрнуто или в полноэкранном режиме — берём нормальные границы
  if (isMaximized || isFullScreen) {
    currentBounds = mainWindow.getNormalBounds();
  }

  windowState = { ...currentBounds, isMaximized, isFullScreen };
  try {
    fs.writeFileSync(windowStatePath, JSON.stringify(windowState, null, 2));
    console.log('[INFO] Window state saved to:', windowStatePath);
  } catch (e) {
    console.error('[ERROR] Failed to save window state:', e);
  }
}

function restoreWindowState() {
  try {
    const data = fs.readFileSync(windowStatePath, 'utf8');
    windowState = JSON.parse(data);
    // Валидация состояния
    if (windowState &&
        typeof windowState.x === 'number' &&
        typeof windowState.y === 'number' &&
        typeof windowState.width === 'number' &&
        typeof windowState.height === 'number' &&
        typeof windowState.isMaximized === 'boolean' &&
        typeof windowState.isFullScreen === 'boolean') {
      console.log('[INFO] Window state restored from:', windowStatePath);
      return windowState;
    }
  } catch (e) {
    console.warn('[WARN] Failed to load window state, using defaults:', e);
  }
  // Значения по умолчанию
  return {
    width: 1000,
    height: 800,
    x: undefined,
    y: undefined,
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
    show: false,
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
      saveWindowState();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

async function startApp() {
  // Запускаем Express-сервер из src/app.js
  const appModule = require('./src/app');
  const port = await appModule.startServer();

  const url = `http://localhost:${port}/console`;
  createWindow(url);
}

app.on('ready', () => {
  console.log('[INFO] App is ready. userData path:', app.getPath('userData'));

  startApp().then(() => {
    tray = new Tray(path.join(__dirname, 'icon.png'));
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Открыть',
        click: () => {
          if (mainWindow) mainWindow.show();
        },
      },
      {
        label: 'Выйти',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setToolTip('Zabbix NP Node');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
      if (mainWindow && !mainWindow.isVisible()) {
        mainWindow.show();
      }
    });
  });
});

app.on('window-all-closed', () => {
  // На macOS приложения обычно не закрываются, пока пользователь не выйдет явно
  if (process.platform !== 'darwin') {
    // Ничего не делаем — приложение живёт в трее
  }
});

app.on('before-quit', () => {
  saveWindowState();
});

app.on('activate', () => {
  if (mainWindow === null) {
    startApp();
  } else {
    mainWindow.show();
  }
});