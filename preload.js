// =====================================================================
//  Preload — runs with Node access and hands the page two safe things:
//   1) a stable per-machine id (so a code can be locked to one PC)
//   2) the activation server URL, read from an editable config file
//      so the URL can change without rebuilding the app.
// =====================================================================
const { contextBridge, ipcRenderer } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A machine fingerprint that stays the same across reinstalls and data
// clears (it's derived from hardware/host, not from anything we store).
function machineId(){
  try{
    const nets = os.networkInterfaces();
    const macs = [];
    for(const name in nets){
      for(const n of nets[name]){
        if(n && !n.internal && n.mac && n.mac !== '00:00:00:00:00:00') macs.push(n.mac);
      }
    }
    macs.sort();
    const basis = macs.join(',') + '|' + os.hostname() + '|' + os.platform() + '|' + os.arch();
    return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32);
  }catch(e){
    return '';
  }
}

// Read the activation URL from resources/activation-config.json (next to the
// app). If it's missing or blank, the app falls back to offline mode.
function activationUrl(){
  const candidates = [];
  try{ candidates.push(path.join(process.resourcesPath || '', 'activation-config.json')); }catch(e){}
  try{ candidates.push(path.join(__dirname, 'activation-config.json')); }catch(e){}
  for(const p of candidates){
    try{
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if(cfg && typeof cfg.activationUrl === 'string') return cfg.activationUrl.trim();
    }catch(e){ /* try next */ }
  }
  return '';
}


// --- One-click updater: download the new installer, then hand it to the
//     main process to run (main closes the app so files can be replaced). ---
function downloadUpdate(url, onProgress){
  return new Promise(function(resolve, reject){
    if(!url){ reject(new Error('no-url')); return; }
    var dest = path.join(os.tmpdir(), 'ID-Picture-Layout-Update.exe');
    var redirects = 0;
    function get(u){
      var mod = u.indexOf('https') === 0 ? require('https') : require('http');
      var req = mod.get(u, { headers: { 'User-Agent': 'IDPL-Updater' } }, function(res){
        if([301,302,303,307,308].indexOf(res.statusCode) >= 0 && res.headers.location){
          res.resume();
          if(++redirects > 6){ reject(new Error('too-many-redirects')); return; }
          var loc = res.headers.location;
          try{ if(loc.charAt(0) === '/'){ var U = new URL(u); loc = U.origin + loc; } }catch(e){}
          get(loc); return;
        }
        if(res.statusCode !== 200){ reject(new Error('http-' + res.statusCode)); return; }
        var ct = res.headers['content-type'] || '';
        if(/text\/html/i.test(ct)){ res.resume(); reject(new Error('not-a-file')); return; }
        var total = parseInt(res.headers['content-length'] || '0', 10);
        var got = 0;
        var out = fs.createWriteStream(dest);
        res.on('data', function(c){
          got += c.length;
          if(total && onProgress){ try{ onProgress(Math.max(1, Math.round(got / total * 100))); }catch(e){} }
        });
        res.pipe(out);
        out.on('finish', function(){ out.close(function(){
          try{ if(fs.statSync(dest).size < 1000000){ reject(new Error('too-small')); return; } }catch(e){}
          resolve(dest);
        }); });
        out.on('error', function(e){ reject(e); });
      });
      req.on('error', function(e){ reject(e); });
      req.setTimeout(180000, function(){ req.destroy(new Error('timeout')); });
    }
    get(url);
  });
}

function installUpdate(file){
  try{ ipcRenderer.send('idpl-run-installer', file); }catch(e){}
}


// --- Formal attire library: imported PNGs persist in a folder so buyers keep
//     their outfits across restarts. ---
function attireDir(){
  var base = process.env.APPDATA || process.env.HOME || os.homedir();
  return path.join(base, 'SIZER', 'attire');
}
function attireEnsure(){ try{ fs.mkdirSync(attireDir(), { recursive:true }); }catch(e){} }
function attireList(){
  attireEnsure();
  try{
    return fs.readdirSync(attireDir()).filter(function(f){ return /\.png$/i.test(f); }).map(function(f){
      try{ var b=fs.readFileSync(path.join(attireDir(), f)); return { name:f, dataURL:'data:image/png;base64,'+b.toString('base64') }; }
      catch(e){ return null; }
    }).filter(Boolean);
  }catch(e){ return []; }
}
function attireSave(name, dataURL){
  attireEnsure();
  var b64 = String(dataURL||'').replace(/^data:image\/\w+;base64,/, '');
  var safe = String(name||'attire').replace(/[^A-Za-z0-9._ -]/g,'_');
  if(!/\.png$/i.test(safe)) safe += '.png';
  fs.writeFileSync(path.join(attireDir(), safe), Buffer.from(b64, 'base64'));
  return safe;
}
function attireRemove(name){
  try{ fs.unlinkSync(path.join(attireDir(), path.basename(String(name)))); return true; }catch(e){ return false; }
}

contextBridge.exposeInMainWorld('idpl', {
  deviceId: (function(){
    try{
      var base = machineId();
      try{
        var raw = typeof localStorage !== 'undefined' ? localStorage.getItem('idpl_device_history') : null;
        var arr = []; if(raw){ try{ arr = JSON.parse(raw); }catch(e){ arr = []; } }
        if(Array.isArray(arr)) for(var k=0;k<arr.length;k++){ if(arr[k] && arr[k] !== base){ base = arr[k]; break; } }
      }catch(e){}
      return base;
    }catch(e){ return machineId(); }
  })(),
  activationUrl: activationUrl(),
  // Which build this is: 'ia32' (32-bit) or 'x64' (64-bit). The update check
  // sends this so a 32-bit customer is offered the 32-bit installer instead
  // of a 64-bit one their Windows cannot run.
  arch: (function(){ try{ return process.arch; }catch(e){ return ''; } })(),
  updater: { download: downloadUpdate, install: installUpdate },
  printer: {
    list:  function(){ return ipcRenderer.invoke('idpl-get-printers'); },
    print: function(opts){ return ipcRenderer.invoke('idpl-print', opts); }
  },
  attire: { list: attireList, save: attireSave, remove: attireRemove, dir: attireDir() }
});
