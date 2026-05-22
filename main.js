const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { enrichOffersWithRelativeCost } = require('./market-rates');

// Keep a global reference of the window object
let mainWindow;

// Path for storing FCM credentials
const credentialsPath = path.join(app.getPath('userData'), 'fcm-credentials.json');

// Path for storing item data
const itemsJsonPath = path.join(app.getPath('userData'), 'items.json');
let ITEM_NAMES = {};

// ==================== ITEM DATA LOADING ====================

async function fetchCorrosionHourMap() {
  const CORROSION_HOUR_URL = 'https://www.corrosionhour.com/rust-item-list/';
  
  try {
    const response = await fetch(CORROSION_HOUR_URL, {
      headers: { 'user-agent': 'rust-trader-electron/1.0' }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching Corrosion Hour`);
    }
    
    const html = await response.text();
    
    // Parse HTML using regex since we don't have cheerio in the renderer
    // This is a simplified parser - in production you might want to use a proper HTML parser
    const map = {};
    
    // Look for table rows with item data
    const rowRegex = /<tr[^>]*>[\s\S]*?<td[^>]*>(.*?)<\/td>[\s\S]*?<td[^>]*>(.*?)<\/td>[\s\S]*?<td[^>]*>(.*?)<\/td>[\s\S]*?<td[^>]*>(.*?)<\/td>/gi;
    let match;
    
    while ((match = rowRegex.exec(html)) !== null) {
      const cells = match.slice(1, 5).map(cell => cell.replace(/<[^>]*>/g, '').trim());
      
      // Try to identify which columns contain what
      // Typically: Display Name, Short Name, Item ID, Category
      if (cells.length >= 3) {
        const possibleId = cells.find(cell => /^-?\d+$/.test(cell));
        const possibleName = cells.find(cell => cell.length > 2 && !(/^-?\d+$/.test(cell)) && (!cell.includes('.') || cell.includes(' ')));
        const possibleShort = cells.find(cell => (cell.includes('.') && !cell.includes(' ')) || (cell.length > 2 && cell !== possibleName && !(/^-?\d+$/.test(cell))));
        
        if (possibleId && possibleName) {
          map[possibleId] = { 
            name: possibleName, 
            short: possibleShort || possibleName.toLowerCase().replace(/\s+/g, '.')
          };
        }
      }
    }
    
    // If parsing failed, try a different approach with cheerio
    if (Object.keys(map).length === 0) {
      console.log('[ITEMS] Simple parse failed, trying with cheerio...');
      const cheerio = require('cheerio');
      const $ = cheerio.load(html);
      const tables = $('table');
      
      tables.each((_, tbl) => {
        const $tbl = $(tbl);
        const headers = $tbl.find('thead th').map((_, th) => $(th).text().trim().toLowerCase()).get();
        if (!headers.length) return;
        
        const nameIdx = headers.findIndex(h => h.includes('display') || h === 'item');
        const shortIdx = headers.findIndex(h => h.includes('short'));
        const idIdx = headers.findIndex(h => h.includes('item id') || h === 'id');
        
        if (nameIdx === -1 || shortIdx === -1 || idIdx === -1) return;
        
        $tbl.find('tbody tr').each((_, tr) => {
          const tds = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
          if (!tds.length) return;
          
          const name = tds[nameIdx];
          const short = tds[shortIdx];
          const idStr = tds[idIdx];
          
          if (!name || !short || !/^-?\d+$/.test(idStr)) return;
          map[idStr] = { name, short };
        });
      });
    }
    
    if (Object.keys(map).length === 0) {
      throw new Error('Could not parse item table from Corrosion Hour');
    }

    // Verify known items parsed correctly
    if (!map['-1211166256']) {
      console.warn('[ITEMS] Warning: 5.56 Rifle Ammo (-1211166256) not found after parsing - possible format change');
    }

    return map;
  } catch (error) {
    console.error('[ITEMS] Failed to fetch from Corrosion Hour:', error);
    throw error;
  }
}

async function loadItemMap() {
  // Check if items.json exists
  if (fs.existsSync(itemsJsonPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(itemsJsonPath, 'utf8'));
      console.log(`[ITEMS] Loaded ${Object.keys(json).length} items from items.json`);
      return json;
    } catch (e) {
      console.warn('[ITEMS] Failed parsing items.json; will try refetch:', e.message);
    }
  }
  
  // Try to fetch from Corrosion Hour
  try {
    console.log('[ITEMS] Fetching item IDs from Corrosion Hour...');
    const map = await fetchCorrosionHourMap();
    fs.writeFileSync(itemsJsonPath, JSON.stringify(map, null, 2));
    console.log(`[ITEMS] Saved ${Object.keys(map).length} items to items.json`);
    return map;
  } catch (e) {
    console.error('[ITEMS] Corrosion Hour fetch failed:', e.message);
    
    // Return basic fallback items
    return {
      "-932201673": { name: "Scrap", short: "scrap" },
      "317398316": { name: "High Quality Metal", short: "metal.hq" },
      "69511070": { name: "Metal Fragments", short: "metal.fragments" },
      "-1461508848": { name: "Wood", short: "wood" },
      "-1581843485": { name: "Stones", short: "stones" },
      "-151838493": { name: "Sulfur", short: "sulfur" },
      "-2099697608": { name: "Cloth", short: "cloth" },
      "1103488722": { name: "Leather", short: "leather" },
      "-1211166256": { name: "5.56 Rifle Ammo", short: "ammo.rifle" },
      "785728077": { name: "Pistol Bullet", short: "ammo.pistol" },
      "1578894260": { name: "Shotgun Slug", short: "ammo.shotgun.slug" },
      "-1685290200": { name: "Incendiary 5.56 Rifle Ammo", short: "ammo.rifle.incendiary" },
      "-1035059994": { name: "Explosive 5.56 Rifle Ammo", short: "ammo.rifle.explosive" }
    };
  }
}

// Initialize item map on app start
async function initializeItemMap() {
  try {
    ITEM_NAMES = await loadItemMap();
  } catch (e) {
    console.error('[ITEMS] Failed to initialize item map:', e);
    ITEM_NAMES = {};
  }
}

function createWindow() {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
	autoHideMenuBar: true, // Hides the menu bar, pressing Alt will show it again
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'icon.ico') // Optional: add an icon if you have one
  });

  // Load the index.html file
  mainWindow.loadFile('index.html');

  // Open the DevTools (optional - remove for production)
  // mainWindow.webContents.openDevTools();

  // Handle window closed event
  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

// This method will be called when Electron has finished initialization
app.whenReady().then(async () => {
  // Initialize item map
  await initializeItemMap();
  
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// ========== IPC HANDLERS ==========

// Get item names
ipcMain.handle('get-item-names', async () => {
  // If we don't have items loaded, try to load them
  if (!ITEM_NAMES || Object.keys(ITEM_NAMES).length === 0) {
    await initializeItemMap();
  }
  return ITEM_NAMES;
});

// Refresh item data from Corrosion Hour
ipcMain.handle('refresh-item-data', async () => {
  try {
    console.log('[ITEMS] Force refreshing from Corrosion Hour...');
    const map = await fetchCorrosionHourMap();
    fs.writeFileSync(itemsJsonPath, JSON.stringify(map, null, 2));
    ITEM_NAMES = map;
    console.log(`[ITEMS] Refreshed ${Object.keys(map).length} items`);
    return { success: true, count: Object.keys(map).length };
  } catch (error) {
    console.error('[ITEMS] Refresh failed:', error);
    return { success: false, error: error.message };
  }
});

// Check if FCM credentials exist
ipcMain.handle('check-credentials', async () => {
  return fs.existsSync(credentialsPath);
});

// Get FCM credentials
ipcMain.handle('get-credentials', async () => {
  try {
    if (fs.existsSync(credentialsPath)) {
      const data = fs.readFileSync(credentialsPath, 'utf8');
      const credentials = JSON.parse(data);
      
      // Check if credentials need fixing (missing steamId or have fcm_credentials nested)
      if (!credentials.steamId || !credentials.gcm || !credentials.fcm) {
        
        // Try to load from rustplus.config.json if it exists
        const rustplusConfigPath = path.join(__dirname, 'rustplus.config.json');
        if (fs.existsSync(rustplusConfigPath)) {
          console.log('Fixing credentials from rustplus.config.json');
          const configData = fs.readFileSync(rustplusConfigPath, 'utf8');
          const config = JSON.parse(configData);
          
          // Parse the actual structure
          let processedCredentials = {};
          
          // Extract FCM credentials
          if (config.fcm_credentials) {
            processedCredentials.gcm = config.fcm_credentials.gcm;
            processedCredentials.fcm = config.fcm_credentials.fcm;
          }
          
          // Extract Expo token
          if (config.expo_push_token) {
            processedCredentials.expo = {
              token: config.expo_push_token
            };
          }
          
          // Extract Steam ID from the rustplus_auth_token
          if (config.rustplus_auth_token) {
            processedCredentials.rustplus_auth = config.rustplus_auth_token;
            
            try {
              const tokenParts = config.rustplus_auth_token.split('.');
              if (tokenParts.length >= 2) {
                let base64 = tokenParts[0];
                while (base64.length % 4) {
                  base64 += '=';
                }
                const decoded = Buffer.from(base64, 'base64').toString('utf8');
                const payload = JSON.parse(decoded);
                processedCredentials.steamId = payload.steamId;
              }
            } catch (e) {
              console.error('Failed to extract Steam ID from token:', e);
            }
          }
          
          // Save the fixed credentials
          fs.writeFileSync(credentialsPath, JSON.stringify(processedCredentials, null, 2));
          return processedCredentials;
        }
      }
      
      return credentials;
    }
    return null;
  } catch (error) {
    console.error('Error reading credentials:', error);
    return null;
  }
});

// Delete FCM credentials
ipcMain.handle('delete-credentials', async () => {
  try {
    let deleted = false;
    
    // Delete our saved credentials
    if (fs.existsSync(credentialsPath)) {
      fs.unlinkSync(credentialsPath);
      deleted = true;
      console.log('Deleted fcm-credentials.json');
    }
    
    // Also delete rustplus.config.json if it exists
    const rustplusConfigPath = path.join(__dirname, 'rustplus.config.json');
    if (fs.existsSync(rustplusConfigPath)) {
      fs.unlinkSync(rustplusConfigPath);
      console.log('Deleted rustplus.config.json');
      deleted = true;
    }
    
    return deleted;
  } catch (error) {
    console.error('Error deleting credentials:', error);
    return false;
  }
});

// Generate FCM credentials using rustplus.js CLI
ipcMain.handle('generate-credentials', async () => {
  return new Promise((resolve, reject) => {
    // Path to the rustplus.config.json file that will be created
    const rustplusConfigPath = path.join(__dirname, 'rustplus.config.json');
    
    // Use npx to run the @liamcottle/rustplus.js command
    const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    
    // Run the fcm-register command using npx
    const child = spawn(command, ['@liamcottle/rustplus.js', 'fcm-register'], {
      cwd: __dirname,
      shell: false,
      env: { ...process.env, FORCE_COLOR: '0' } // Disable colored output for easier parsing
    });

    let output = '';
    let errorOutput = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
      console.log('FCM Register Output:', data.toString());
    });

    child.stderr.on('data', (data) => {
      errorOutput += data.toString();
      console.error('FCM Register Error:', data.toString());
    });

    child.on('error', (error) => {
      console.error('Failed to start FCM registration:', error);
      reject(new Error(`Failed to start FCM registration: ${error.message}`));
    });

    child.on('close', (code) => {
      console.log('FCM registration process exited with code:', code);
      
      if (code === 0) {
        // Read the credentials from rustplus.config.json
        try {
          if (fs.existsSync(rustplusConfigPath)) {
            const configData = fs.readFileSync(rustplusConfigPath, 'utf8');
            const config = JSON.parse(configData);
            
            console.log('Full config from rustplus.config.json:', config);
            
            // Parse the actual structure from rustplus.config.json
            let processedCredentials = {};
            
            // Extract FCM credentials
            if (config.fcm_credentials) {
              processedCredentials.gcm = config.fcm_credentials.gcm;
              processedCredentials.fcm = config.fcm_credentials.fcm;
            }
            
            // Extract Expo token
            if (config.expo_push_token) {
              processedCredentials.expo = {
                token: config.expo_push_token
              };
            }
            
            // Extract Steam ID from the rustplus_auth_token (it's a JWT)
            if (config.rustplus_auth_token) {
              processedCredentials.rustplus_auth = config.rustplus_auth_token;
              
              // Decode the JWT to get steamId (first part before the dot is base64 encoded JSON)
              try {
                const tokenParts = config.rustplus_auth_token.split('.');
                if (tokenParts.length >= 2) {
                  // Add padding if necessary
                  let base64 = tokenParts[0];
                  while (base64.length % 4) {
                    base64 += '=';
                  }
                  const decoded = Buffer.from(base64, 'base64').toString('utf8');
                  const payload = JSON.parse(decoded);
                  processedCredentials.steamId = payload.steamId;
                  console.log('Extracted Steam ID:', payload.steamId);
                }
              } catch (e) {
                console.error('Failed to extract Steam ID from token:', e);
              }
            }
            
            // Save processed credentials to our app's location
            fs.writeFileSync(credentialsPath, JSON.stringify(processedCredentials, null, 2));
            console.log('Successfully saved FCM credentials to:', credentialsPath);
            console.log('Saved credentials:', processedCredentials);
            
            resolve(processedCredentials);
          } else {
            reject(new Error('rustplus.config.json was not created'));
          }
        } catch (error) {
          console.error('Error reading/parsing credentials:', error);
          reject(new Error(`Failed to read credentials: ${error.message}`));
        }
      } else {
        reject(new Error(`FCM registration failed with code ${code}: ${errorOutput || output}`));
      }
    });
  });
});

// ========== PAIRING LISTENER ==========

let fcmListener = null;
let fcmClient = null;

// Start listening for pairing notifications
ipcMain.handle('start-pairing-listener', async () => {
  try {
    // Load credentials
    if (!fs.existsSync(credentialsPath)) {
      throw new Error('No FCM credentials found');
    }
    
    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    console.log('Loaded credentials for pairing:', credentials);
    
    // Import push-receiver dynamically
    const PushReceiverClient = require('@liamcottle/push-receiver/src/client');
    
    // Check if we have valid GCM credentials
    if (!credentials.gcm || !credentials.gcm.androidId || !credentials.gcm.securityToken) {
      throw new Error('Invalid or missing GCM credentials. Please regenerate.');
    }
    
    const androidId = credentials.gcm.androidId;
    const securityToken = credentials.gcm.securityToken;
    
    console.log('Starting FCM listener with androidId:', androidId);
    
    fcmClient = new PushReceiverClient(androidId, securityToken, []);
    
    // Connect to FCM
    await fcmClient.connect();
    console.log('FCM client connected');
    
    // Set up notification listener
    fcmClient.on('ON_DATA_RECEIVED', (notification) => {
      console.log('Received FCM notification:', notification);
      
      try {
        let data = null;
        
        // Parse notification data
        if (notification.appData) {
          const bodyEntry = notification.appData.find(item => item.key === 'body');
          if (bodyEntry && bodyEntry.value) {
            try {
              data = JSON.parse(bodyEntry.value);
            } catch (e) {
              console.error('Failed to parse notification body:', e);
              return;
            }
          }
        }
        
        // Check if it's a server pairing notification
        if (data && data.type === 'server') {
          console.log('Server pairing notification received:', data);
          
          const pairingData = {
            serverName: data.name || 'Unknown Server',
            serverIp: data.ip,
            appPort: parseInt(data.port),
            playerId: data.playerId || credentials.steamId,
            playerToken: data.playerToken
          };
          
          // Send to renderer
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('pairing-update', {
              type: 'pairing-received',
              data: pairingData
            });
          }
        }
      } catch (error) {
        console.error('Error processing notification:', error);
      }
    });
    
    // Send success message to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pairing-update', {
        type: 'listening-started'
      });
    }
    
    return { success: true };
    
  } catch (error) {
    console.error('Error starting pairing listener:', error);
    throw error;
  }
});

// Stop listening for pairing notifications
ipcMain.handle('stop-pairing-listener', async () => {
  try {
    if (fcmClient) {
      fcmClient.destroy();
      fcmClient = null;
      console.log('FCM listener stopped');
    }
    
    // Send stop message to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pairing-update', {
        type: 'listening-stopped'
      });
    }
    
    return { success: true };
  } catch (error) {
    console.error('Error stopping pairing listener:', error);
    return { success: false, error: error.message };
  }
});

// ========== SERVER MANAGEMENT ==========

const serversPath = path.join(app.getPath('userData'), 'servers.json');

// Get all saved servers
ipcMain.handle('get-servers', async () => {
  try {
    if (fs.existsSync(serversPath)) {
      const data = fs.readFileSync(serversPath, 'utf8');
      return JSON.parse(data);
    }
    return [];
  } catch (error) {
    console.error('Error reading servers:', error);
    return [];
  }
});

// Save a new server
ipcMain.handle('save-server', async (event, serverData) => {
  try {
    let servers = [];
    if (fs.existsSync(serversPath)) {
      const data = fs.readFileSync(serversPath, 'utf8');
      servers = JSON.parse(data);
    }
    
    // Check if server already exists
    const existingIndex = servers.findIndex(s => 
      s.serverIp === serverData.serverIp && s.appPort === serverData.appPort
    );
    
    if (existingIndex >= 0) {
      // Update existing server
      servers[existingIndex] = { ...serverData, id: servers[existingIndex].id };
    } else {
      // Add new server with unique ID
      serverData.id = Date.now().toString();
      servers.push(serverData);
    }
    
    fs.writeFileSync(serversPath, JSON.stringify(servers, null, 2));
    console.log('Server saved:', serverData.serverName);
    return { success: true, servers };
  } catch (error) {
    console.error('Error saving server:', error);
    return { success: false, error: error.message };
  }
});

// Delete a server
ipcMain.handle('delete-server', async (event, serverId) => {
  try {
    if (fs.existsSync(serversPath)) {
      const data = fs.readFileSync(serversPath, 'utf8');
      let servers = JSON.parse(data);
      servers = servers.filter(s => s.id !== serverId);
      fs.writeFileSync(serversPath, JSON.stringify(servers, null, 2));
      return { success: true, servers };
    }
    return { success: false, error: 'No servers found' };
  } catch (error) {
    console.error('Error deleting server:', error);
    return { success: false, error: error.message };
  }
});

// ========== RUSTPLUS CONNECTION ==========

const RustPlus = require('@liamcottle/rustplus.js');
let activeConnection = null;

// Helper function to calculate map size from map data
function calculateMapSize(mapData) {
  const effectiveWidth = mapData.width - (2 * mapData.oceanMargin);
  const effectiveHeight = mapData.height - (2 * mapData.oceanMargin);
  const standardSizes = [1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000];
  const estimatedSize = Math.max(effectiveWidth, effectiveHeight) * 2;
  let closestSize = standardSizes[0];
  let minDiff = Math.abs(estimatedSize - closestSize);

  for (const size of standardSizes) {
    const diff = Math.abs(estimatedSize - size);
    if (diff < minDiff) {
      minDiff = diff;
      closestSize = size;
    }
  }

  console.log(`[MAP SIZE] Estimated ${estimatedSize}, using: ${closestSize}`);
  return closestSize;
}

// Connect to a server and get vending machine data
ipcMain.handle('get-vending-data', async (event, server) => {
  try {
    console.log(`Connecting to ${server.serverName}...`);
    
    // Disconnect existing connection if any
    if (activeConnection) {
      activeConnection.disconnect();
      activeConnection = null;
    }
    
    // Create new RustPlus connection
    const rustplus = new RustPlus(server.serverIp, server.appPort, server.playerId, server.playerToken);
    activeConnection = rustplus;
    
    // Connect with timeout
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);
      
      rustplus.once('connected', () => {
        clearTimeout(timeout);
        console.log('RustPlus connected successfully');
        resolve();
      });
      
      rustplus.once('error', (err) => {
        clearTimeout(timeout);
        console.error('RustPlus connection error:', err);
        reject(err);
      });
      
      rustplus.connect();
    });
    
    // Get map data to calculate map size
    const mapInfo = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log('Map data timeout');
        resolve(null);
      }, 5000);
      
      rustplus.getMap((mapData) => {
        clearTimeout(timeout);
        
        if (mapData && mapData.response && mapData.response.map) {
          const map = mapData.response.map;
          const mapSize = calculateMapSize(map);
          resolve({
            mapSize,
            width: map.width,
            height: map.height,
            oceanMargin: map.oceanMargin
          });
        } else {
          resolve(null);
        }
      });
    });
    
    const mapSize = mapInfo?.mapSize || 4000;
    
    // Get server info using callback
    const serverInfo = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log('Server info timeout');
        resolve(null);
      }, 5000);
      
      rustplus.getInfo((response) => {
        clearTimeout(timeout);
        
        if (response && response.response && response.response.info) {
          resolve(response.response.info);
        } else if (response && response.info) {
          resolve(response.info);
        } else {
          resolve(null);
        }
      });
    });
    
    // Try to get player position (will be null if not in team)
    const playerPosition = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log('[PLAYER] Position fetch timeout - likely not in a team');
        resolve(null);
      }, 5000);
      
      rustplus.getTeamInfo((teamInfo) => {
        clearTimeout(timeout);
        
        // Check for error response (happens when not in a team)
        if (teamInfo?.response?.error) {
          resolve(null);
          return;
        }
        
        // Check if we have valid team info
        if (teamInfo && teamInfo.response && teamInfo.response.teamInfo) {
          const members = teamInfo.response.teamInfo.members;
          
          if (!members || members.length === 0) {
            resolve(null);
            return;
          }
          
          // Try to find the player in the team by matching steamId
          const you = members.find(m => {
            const memberSteamId = m.steamId?.toString() || String(m.steamId);
            return memberSteamId === server.playerId;
          });
          
          if (you && you.x != null && you.y != null) {
            const worldX = you.x - (mapSize / 2);
            const worldY = you.y - (mapSize / 2);
            resolve({
              x: worldX,
              y: worldY,
              name: you.name,
              isAlive: you.isAlive
            });
          } else {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });
    });
    
    // Get map markers using callback
    const vendingMachines = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log('Map markers timeout');
        resolve([]);
      }, 10000);
      
      rustplus.getMapMarkers((message) => {
        clearTimeout(timeout);
        
        if (message?.response?.error) {
          console.error('Map markers error:', message.response.error);
          resolve([]);
          return;
        }
        
        let markers = [];
        
        if (message && message.response && message.response.mapMarkers && message.response.mapMarkers.markers) {
          markers = message.response.mapMarkers.markers;
          
          // Filter for vending machines (type 3) and convert coordinates
          const vending = markers
            .filter(marker => marker.type === 3)
            .map(marker => {
              // Convert to world coordinates
              const worldX = marker.x - (mapSize / 2);
              const worldY = marker.y - (mapSize / 2);
              
              return {
                id: marker.id,
                x: worldX,
                y: worldY,
                name: marker.name || 'Vending Machine',
                sellOrders: marker.sellOrders || []
              };
            });
          
          resolve(vending);
        } else {
          resolve([]);
        }
      });
    });
    
    // Disconnect after getting data
    rustplus.disconnect();
    activeConnection = null;

    const { machines: enrichedVendingMachines, marketContext } = enrichOffersWithRelativeCost(
      vendingMachines,
      ITEM_NAMES
    );
    
    return {
      success: true,
      serverInfo: serverInfo ? {
        name: serverInfo.name || server.serverName,
        players: serverInfo.players || 0,
        maxPlayers: serverInfo.maxPlayers || 0,
        queuedPlayers: serverInfo.queuedPlayers || 0,
        seed: serverInfo.seed || 0,
        size: serverInfo.size || 0,
        wipeTime: serverInfo.wipeTime || null
      } : {
        name: server.serverName,
        players: 0,
        maxPlayers: 0,
        queuedPlayers: 0,
        seed: 0,
        size: 0,
        wipeTime: null
      },
      mapSize,
      playerPosition,
      vendingMachines: enrichedVendingMachines,
      marketContext
    };
    
  } catch (error) {
    console.error('Error getting vending data:', error);
    console.error('Stack trace:', error.stack);
    
    // Clean up connection on error
    if (activeConnection) {
      try {
        activeConnection.disconnect();
      } catch (e) {
        console.error('Error disconnecting:', e);
      }
      activeConnection = null;
    }
    
    return {
      success: false,
      error: error.message
    };
  }
});

// Disconnect active connection when app closes
app.on('before-quit', () => {
  if (activeConnection) {
    activeConnection.disconnect();
  }
});
