const { app, BrowserWindow, Tray, Menu } = require('electron');
const path = require('path');

let mainWindow = null;
let tray = null;

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, 'icon.png')
  });

  mainWindow.loadURL(url);

  mainWindow.on('close', function (event) {
    if (!app.isQuitting) {
      event.preventDefault();
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

app.on('activate', function () {
  if (mainWindow === null) {
      startApp();
  } else {
      mainWindow.show();
  }
});
