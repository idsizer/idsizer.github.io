const { app, BrowserWindow, shell, ipcMain, Menu } = require('electron');
const path = require('path');

// Make SharedArrayBuffer available so the background remover can run its model
// across multiple CPU cores (much faster on low-spec PCs). Harmless if the
// platform ignores it — the app just falls back to single-threaded.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

function createWindow () {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 820,
    minHeight: 600,
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,                               // lets the preload read the machine id + config
      devTools: false,                              // no console => the paid flag can't be flipped by hand
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Remove the application menu (its View submenu can open the inspector).
  try{ Menu.setApplicationMenu(null); }catch(e){}

  // Swallow the developer-tools shortcuts before the page ever sees them.
  win.webContents.on('before-input-event', (event, input) => {
    try{
      const key = (input.key || '').toLowerCase();
      const ctrlOrCmd = input.control || input.meta;
      if(key === 'f12'){ event.preventDefault(); return; }
      if(ctrlOrCmd && input.shift && (key === 'i' || key === 'j' || key === 'c')){ event.preventDefault(); return; }
      if(ctrlOrCmd && key === 'u'){ event.preventDefault(); return; }   // view-source
    }catch(e){}
  });

  // Belt and braces: if anything still manages to open it, close it again.
  win.webContents.on('devtools-opened', () => { try{ win.webContents.closeDevTools(); }catch(e){} });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile('index.html');
}


// One-click update: run the downloaded installer, then quit so it can
// replace the app files. The installer relaunches the app when it finishes.
ipcMain.on('idpl-run-installer', function(evt, file){
  try{
    const { spawn } = require('child_process');
    spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
  }catch(e){}
  setTimeout(function(){ try{ app.quit(); }catch(e){} }, 700);
});

// Print settings panel: list installed printers, and print the sheet with the
// user's chosen options (printer, copies, colour, paper size, margins, scale).
ipcMain.handle('idpl-get-printers', async (e) => {
  try { return await e.sender.getPrintersAsync(); } catch(err){ return []; }
});
ipcMain.handle('idpl-print', async (e, opts) => {
  return await new Promise((resolve) => {
    try { e.sender.print(opts || {}, (success, failureReason) => resolve({ success, failureReason })); }
    catch(err){ resolve({ success:false, failureReason:String(err) }); }
  });
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
