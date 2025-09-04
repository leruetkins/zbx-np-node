const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow = null;

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL(url);

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

app.on('ready', startApp);

app.on('window-all-closed', function () {
  // On macOS it is common for applications to stay open until the user quits explicitly
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', function () {
  if (mainWindow === null) startApp();
});
