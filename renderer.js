// renderer.js - UI Logic for Rust Trader with Server Management

let currentCredentials = null;
let servers = [];
let currentServer = null;
let isListening = false;
let vendingData = null;
let currentCategory = 'all';
let ITEM_NAMES = {};  // Will be loaded from Corrosion Hour data
let playerPosition = null;  // Store player position for distance calculations
let mapSize = 4000;  // Store map size from server
let sortState = { column: 'name', direction: 'asc' };

const SORT_HEADER_KEYS = {
    item: 'name',
    itemQty: 'quantity',
    costItem: 'currency',
    costQty: 'price',
    costEach: 'costEach',
    stock: 'stock',
    shop: 'shop',
    location: 'location',
    distance: 'distance',
    relativeCost: 'relativeCost',
    relativeCostEach: 'relativeCostUnit',
    relativeValue: 'relativeValue',
    relativeValueEach: 'relativeValueUnit',
    relativeSpread: 'relativeSpread'
};

/** Cost (Each) = Cost Qty ÷ Item Qty (payment per one sold item). Does not affect relative cost/value. */
function getCostEach(costQty, itemQty) {
    const cost = Number(costQty);
    const qty = Number(itemQty);
    if (!Number.isFinite(cost) || !Number.isFinite(qty) || qty <= 0) {
        return Number.isFinite(cost) ? cost : 0;
    }
    return cost / qty;
}

function formatCostEach(costQty, itemQty) {
    const each = getCostEach(costQty, itemQty);
    if (!Number.isFinite(each)) return '';
    return Number.isInteger(each) ? String(each) : String(Number(each.toFixed(2)));
}

const MIN_RELATIVE_COST_DISPLAY = 0.01;
const MIN_RELATIVE_UNIT_DISPLAY = 0.0001;

function formatRelativeNumber(value) {
    if (value == null || !Number.isFinite(value) || value < MIN_RELATIVE_COST_DISPLAY) return '';
    const rounded = Number(value.toFixed(2));
    if (!Number.isFinite(rounded) || rounded < MIN_RELATIVE_COST_DISPLAY) return '';
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function formatRelativeSpreadNumber(value) {
    if (value == null || !Number.isFinite(value)) return '';
    if (value === 0) return '0';
    const rounded = Number(value.toFixed(2));
    if (!Number.isFinite(rounded)) return '';
    const absRounded = Math.abs(rounded);
    if (absRounded > 0 && absRounded < MIN_RELATIVE_COST_DISPLAY) return '';
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function formatFineRelativeNumber(value) {
    const fine = Number(value.toFixed(6));
    return Number.isFinite(fine) && fine > 0 ? String(fine) : '';
}

function formatRelativeUnitNumber(value) {
    if (value == null || !Number.isFinite(value) || value <= 0) return '';
    if (value < MIN_RELATIVE_COST_DISPLAY) {
        return formatFineRelativeNumber(value);
    }
    return formatRelativeNumber(value);
}

function formatRelativeValueNumber(value) {
    if (value == null || !Number.isFinite(value) || value <= 0) return '';
    if (value < MIN_RELATIVE_COST_DISPLAY) {
        return formatFineRelativeNumber(value);
    }
    return formatRelativeNumber(value);
}

function relativeCostDatasetValue(value) {
    return formatRelativeNumber(value) || '';
}

function relativeUnitDatasetValue(value) {
    return formatRelativeUnitNumber(value) || '';
}

function updateRelativeCostHint(marketContext) {
    const hint = document.getElementById('relativeCostBase');
    if (!hint) return;
    if (marketContext?.selectedBaseCurrencyName) {
        hint.textContent = `Relative cost & value shown in: ${marketContext.selectedBaseCurrencyName}`;
        hint.style.display = 'block';
    } else {
        hint.textContent = '';
        hint.style.display = 'none';
    }
}

// Initialize on load
window.addEventListener('DOMContentLoaded', async () => {
    // Load item names first
    await loadItemNames();
    await checkSetup();
});

// Load item names from main process (fetched from Corrosion Hour)
async function loadItemNames() {
    try {
        ITEM_NAMES = await window.electronAPI.getItemNames();
        console.log(`[ITEMS] Loaded ${Object.keys(ITEM_NAMES).length} item names`);
        
        // If we don't have many items, try to refresh
        if (Object.keys(ITEM_NAMES).length < 100) {
            console.log('[ITEMS] Item count seems low, attempting refresh...');
            const result = await window.electronAPI.refreshItemData();
            if (result.success) {
                ITEM_NAMES = await window.electronAPI.getItemNames();
                console.log(`[ITEMS] Refreshed to ${Object.keys(ITEM_NAMES).length} items`);
            }
        }
    } catch (error) {
        console.error('[ITEMS] Failed to load item names:', error);
        ITEM_NAMES = {};
    }
}

// Check initial setup
async function checkSetup() {
    const hasCredentials = await window.electronAPI.checkCredentials();
    
    if (!hasCredentials) {
        // Show setup state
        document.getElementById('setupState').style.display = 'flex';
        document.getElementById('appState').style.display = 'none';
    } else {
        // Show app state
        document.getElementById('setupState').style.display = 'none';
        document.getElementById('appState').style.display = 'flex';
        
        // Load credentials
        currentCredentials = await window.electronAPI.getCredentials();
        
        // Load servers
        await loadServers();
    }
}

// Generate FCM credentials
async function generateCredentials() {
    const generateBtn = document.getElementById('generateBtn');
    const statusText = document.getElementById('credentialStatusText');
    
    try {
        generateBtn.disabled = true;
        generateBtn.textContent = 'Generating...';
        statusText.textContent = 'Generating credentials...';
        
        const credentials = await window.electronAPI.generateCredentials();
        
        if (credentials) {
            statusText.textContent = 'Credentials generated successfully!';
            setTimeout(() => {
                checkSetup();
            }, 1500);
        } else {
            throw new Error('Failed to generate credentials');
        }
    } catch (error) {
        console.error('Error generating credentials:', error);
        statusText.textContent = 'Failed to generate credentials: ' + error.message;
    } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate Credentials';
    }
}

// Load saved servers
async function loadServers() {
    servers = await window.electronAPI.getServers();
    renderServerList();
    
    // If no servers, show empty state
    if (servers.length === 0) {
        showNoServerState();
    }
}

// Render server list in sidebar
function renderServerList() {
    const serverList = document.getElementById('serverList');
    serverList.innerHTML = '';
    
    servers.forEach(server => {
        const serverItem = document.createElement('div');
        serverItem.className = 'server-item' + (currentServer?.id === server.id ? ' active' : '');
        serverItem.onclick = () => selectServer(server);
        
        serverItem.innerHTML = `
            <div class="server-item-info">
                <div class="server-item-name">${server.serverName}</div>
                <div class="server-item-ip">${server.serverIp}:${server.appPort}</div>
            </div>
            <button class="server-delete-btn" onclick="event.stopPropagation(); deleteServer('${server.id}')">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" 
                          stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
            </button>
        `;
        
        serverList.appendChild(serverItem);
    });
}

// Select a server
async function selectServer(server) {
    currentServer = server;
    
    // Update active state in sidebar
    document.querySelectorAll('.server-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // Find and highlight the current server item
    const serverItems = document.querySelectorAll('.server-item');
    serverItems.forEach(item => {
        if (item.onclick && item.onclick.toString().includes(server.id)) {
            item.classList.add('active');
        }
    });
    
    // Show server state
    document.getElementById('noServerState').style.display = 'none';
    document.getElementById('serverSelectedState').style.display = 'block';
    
    // Update server name
    document.getElementById('serverName').textContent = server.serverName;
    
    // Load vending data
    await loadVendingData();
}

// Load vending machine data
async function loadVendingData() {
    if (!currentServer) return;
    
    // Show loading
    document.getElementById('loadingVending').style.display = 'flex';
    document.querySelector('.shops-container').style.display = 'none';
    document.getElementById('noItemsState').style.display = 'none';
    
    try {
        const result = await window.electronAPI.getVendingData(currentServer);
        
        if (result.success) {
            vendingData = result;
            
            // Store map size and player position for calculations
            mapSize = result.mapSize || 4000;
            playerPosition = result.playerPosition || null;
            
            // Update server info
            if (result.serverInfo) {
                document.getElementById('playerCount').textContent = 
                    `${result.serverInfo.players}/${result.serverInfo.maxPlayers}`;
                document.getElementById('serverSize').textContent = 
                    `${result.serverInfo.size}`;
            }
            
            updateRelativeCostHint(result.marketContext);

            // Render vending machines
            renderVendingMachines(result.vendingMachines);
        } else {
            throw new Error(result.error || 'Failed to connect to server');
        }
    } catch (error) {
        console.error('Error loading vending data:', error);
        document.querySelector('.shops-container').innerHTML = `
            <div class="error-message" style="padding: 20px; color: var(--danger); text-align: center;">
                Failed to connect to server: ${error.message}
            </div>
        `;
        document.querySelector('.shops-container').style.display = 'block';
    } finally {
        document.getElementById('loadingVending').style.display = 'none';
    }
}

// Render vending machines and their items
function renderVendingMachines(machines) {
    const shopsList = document.getElementById('shopsList');
    const shopsContainer = document.querySelector('.shops-container');
    
    if (!shopsList) {
        console.error('shopsList element not found!');
        return;
    }
    
    shopsList.innerHTML = '';
    
    if (!machines || machines.length === 0) {
        document.getElementById('noItemsState').style.display = 'block';
        shopsContainer.style.display = 'none';
        updateStats(0, 0, 0);
        return;
    }
    
    document.getElementById('noItemsState').style.display = 'none';
    shopsContainer.style.display = 'block';
    
    // Process all items from all machines
    const allItems = [];
    let totalShops = 0;
    
    machines.forEach(machine => {
        if (machine.sellOrders && machine.sellOrders.length > 0) {
            totalShops++;
            machine.sellOrders.forEach(order => {
                // Calculate distance if player position is available
                let distance = null;
                if (playerPosition) {
                    const dx = machine.x - playerPosition.x;
                    const dy = machine.y - playerPosition.y;
                    distance = Math.sqrt(dx * dx + dy * dy);
                }
                
                allItems.push({
                    ...order,
                    machineName: machine.name,
                    machineId: machine.id,
                    x: machine.x,
                    y: machine.y,
                    distance: distance
                });
            });
        }
    });
    
    // Create header
    const header = `
        <div class="list-header">
            <div class="sortable-header" data-sort="itemQty" onclick="handleColumnSort('itemQty')">Item Qty<span class="sort-indicator"></span></div>
            <div class="sortable-header" data-sort="item" onclick="handleColumnSort('item')">Item<span class="sort-indicator"></span></div>
            <div class="sortable-header" data-sort="relativeValue" onclick="handleColumnSort('relativeValue')">Relative Value<span class="sort-indicator"></span></div>
            <div class="sortable-header" data-sort="relativeValueEach" onclick="handleColumnSort('relativeValueEach')">Relative Value (Each)<span class="sort-indicator"></span></div>
            <div class="sortable-header" data-sort="costQty" onclick="handleColumnSort('costQty')">Cost Qty<span class="sort-indicator"></span></div>
            <div class="sortable-header" data-sort="costItem" onclick="handleColumnSort('costItem')">Cost Item<span class="sort-indicator"></span></div>
            <div class="sortable-header" data-sort="costEach" onclick="handleColumnSort('costEach')">Cost (Each)<span class="sort-indicator"></span></div>
            <div class="sortable-header" data-sort="relativeCost" onclick="handleColumnSort('relativeCost')">Relative Cost<span class="sort-indicator"></span></div>
            <div class="sortable-header" data-sort="relativeCostEach" onclick="handleColumnSort('relativeCostEach')">Relative Cost (Each)<span class="sort-indicator"></span></div>
            <div class="sortable-header" data-sort="relativeSpread" onclick="handleColumnSort('relativeSpread')">Relative Spread<span class="sort-indicator"></span></div>
            <div class="sortable-header" data-sort="stock" onclick="handleColumnSort('stock')">Stock<span class="sort-indicator"></span></div>
            <div class="sortable-header" data-sort="shop" onclick="handleColumnSort('shop')">Shop<span class="sort-indicator"></span></div>
            <div class="sortable-header" data-sort="location" onclick="handleColumnSort('location')">Location<span class="sort-indicator"></span></div>
            <div class="sortable-header" data-sort="distance" onclick="handleColumnSort('distance')">Distance<span class="sort-indicator"></span></div>
        </div>
    `;
    
    // Create rows
    const rows = allItems.map(item => {
        // Handle undefined/null stock values - default to 0
        const stock = item.amountInStock ?? 0;
        const outOfStock = stock === 0;
        const itemName = getItemName(item.itemId);
        const currencyName = getItemName(item.currencyId);
        const gridPos = getGridPosition(item.x, item.y);
        const distanceText = item.distance !== null && item.distance !== undefined 
            ? `${Math.round(item.distance)}m` 
            : '-';
        const itemQty = item.quantity ?? 1;
        const costQty = item.costPerItem ?? 0;
        const costEach = getCostEach(costQty, itemQty);
        const relativeValueDisplay = formatRelativeValueNumber(item.relativeValue);
        const relativeValueEachDisplay = formatRelativeUnitNumber(item.relativeValueUnitPrice);
        const relativeValueUnit = formatRelativeUnitNumber(item.relativeValueUnitPrice) || '';
        const relativeValue = formatRelativeValueNumber(item.relativeValue) || '';
        const relativeCostDisplay = formatRelativeNumber(item.relativeCost);
        const relativeEachDisplay = formatRelativeUnitNumber(item.relativeCostUnitPrice);
        const relativeUnit = relativeUnitDatasetValue(item.relativeCostUnitPrice);
        const relativeCost = relativeCostDatasetValue(item.relativeCost);
        const relativeSpreadDisplay = formatRelativeSpreadNumber(item.relativeSpread);
        const relativeSpread = formatRelativeSpreadNumber(item.relativeSpread) || '';
        
        return `
            <div class="shop-row ${outOfStock ? 'out-of-stock' : ''}" 
                 data-item="${itemName.toLowerCase()}"
                 data-currency="${currencyName.toLowerCase()}"
                 data-shop="${item.machineName.toLowerCase()}"
                 data-location="${gridPos}"
                 data-stock="${stock}"
                 data-quantity="${itemQty}"
                 data-price="${costQty}"
                 data-cost-each="${costEach}"
                 data-distance="${item.distance || Infinity}"
                 data-relative-unit="${relativeUnit}"
                 data-relative-cost="${relativeCost}"
                 data-relative-value-unit="${relativeValueUnit}"
                 data-relative-value="${relativeValue}"
                 data-relative-spread="${relativeSpread}"
                 data-original-display="">
                <div class="item-qty" data-label="Item Qty">${itemQty}</div>
                <div class="sale" data-label="Item">
                    <span>${itemName}</span>
                </div>
                <div class="relative-value" data-label="Relative Value">${relativeValueDisplay}</div>
                <div class="relative-value-each" data-label="Relative Value (Each)">${relativeValueEachDisplay}</div>
                <div class="cost-qty" data-label="Cost Qty">${costQty}</div>
                <div class="cost-item" data-label="Cost Item">
                    <span>${currencyName}</span>
                </div>
                <div class="cost-each" data-label="Cost (Each)">${formatCostEach(costQty, itemQty)}</div>
                <div class="relative-cost" data-label="Relative Cost">${relativeCostDisplay}</div>
                <div class="relative-cost-each" data-label="Relative Cost (Each)">${relativeEachDisplay}</div>
                <div class="relative-spread" data-label="Relative Spread">${relativeSpreadDisplay}</div>
                <div class="stock" data-label="Stock">${stock}</div>
                <div class="shop-name" data-label="Shop">${item.machineName}</div>
                <div class="location" data-label="Location">${gridPos}</div>
                <div class="distance" data-label="Distance">${distanceText}</div>
            </div>
        `;
    }).join('');
    
    shopsList.innerHTML = header + rows;
    updateSortHeaders();
    
    // Make sure the container is visible
    shopsContainer.style.display = 'block';
    
    // Update stats
    updateStats(totalShops, allItems.length, allItems.length);
    
    // Apply any existing filters after rendering
    filterShops();
}

function sortByToState(value) {
    switch (value) {
        case 'price': return { column: 'price', direction: 'asc' };
        case 'price_desc': return { column: 'price', direction: 'desc' };
        case 'stock': return { column: 'stock', direction: 'desc' };
        case 'distance': return { column: 'distance', direction: 'asc' };
        case 'name':
        default:
            return { column: 'name', direction: 'asc' };
    }
}

function stateToSortBy({ column, direction }) {
    if (column === 'name' && direction === 'asc') return 'name';
    if (column === 'price' && direction === 'asc') return 'price';
    if (column === 'price' && direction === 'desc') return 'price_desc';
    if (column === 'stock' && direction === 'desc') return 'stock';
    if (column === 'distance' && direction === 'asc') return 'distance';
    return null;
}

function defaultSortDirection(column) {
    if (column === 'stock' || column === 'quantity' || column === 'relativeSpread') return 'desc';
    return 'asc';
}

function syncSortByDropdown() {
    const select = document.getElementById('sortBy');
    if (!select) return;
    const value = stateToSortBy(sortState);
    if (value) select.value = value;
}

function updateSortHeaders() {
    const headers = document.querySelectorAll('.list-header .sortable-header');
    headers.forEach(header => {
        const key = header.dataset.sort;
        const column = SORT_HEADER_KEYS[key];
        const indicator = header.querySelector('.sort-indicator');
        const isActive = column === sortState.column;

        header.classList.toggle('sorted', isActive);
        if (indicator) {
            indicator.className = 'sort-indicator';
            if (isActive) {
                indicator.classList.add(sortState.direction === 'asc' ? 'sort-asc' : 'sort-desc');
            }
        }
    });
}

function onSortDropdownChange() {
    const sortByEl = document.getElementById('sortBy');
    if (sortByEl) sortState = sortByToState(sortByEl.value);
    updateSortHeaders();
    filterShops();
}

function handleColumnSort(headerKey) {
    const column = SORT_HEADER_KEYS[headerKey];
    if (!column) return;

    if (sortState.column === column) {
        sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
    } else {
        sortState.column = column;
        sortState.direction = defaultSortDirection(column);
    }

    syncSortByDropdown();
    updateSortHeaders();
    sortShops();
}

// Get grid position from coordinates
function getGridPosition(worldX, worldY) {
    const gridSize = 150;  // Correct grid size for Rust
    const grids = Math.ceil(mapSize / gridSize);
    
    // worldX and worldY are already in world coordinates (from -mapSize/2 to +mapSize/2)
    // Convert to grid coordinates
    const adjustedX = worldX + (mapSize / 2);
    const adjustedY = worldY + (mapSize / 2);
    
    const gridX = Math.floor(adjustedX / gridSize);
    const gridZ = Math.floor((mapSize - adjustedY) / gridSize);
    
    const clampedX = Math.max(0, Math.min(grids - 1, gridX));
    const clampedZ = Math.max(0, Math.min(grids - 1, gridZ));
    
    // Convert number to letter (A, B, C, ..., Z, AA, AB, etc.)
    function numberToLetter(num) {
        let result = '';
        while (num >= 0) {
            result = String.fromCharCode(65 + (num % 26)) + result;
            num = Math.floor(num / 26) - 1;
            if (num < 0) break;
        }
        return result || 'A';
    }
    
    return `${numberToLetter(clampedX)}${clampedZ}`;
}

// Update stats display
function updateStats(shops, items, matching) {
    document.getElementById('totalShops').textContent = shops;
    document.getElementById('totalItems').textContent = items;
    document.getElementById('matchingItems').textContent = matching;
}

// Filter shops based on all filters
function filterShops() {
    const searchItem = document.getElementById('searchItem').value.toLowerCase();
    const currencyFilter = document.getElementById('currencyFilter').value.toLowerCase();
    const shopNameFilter = document.getElementById('shopNameFilter').value.toLowerCase();
    const hideOutOfStock = document.getElementById('hideOutOfStock').checked;
    
    const rows = document.querySelectorAll('.shop-row');
    let visibleCount = 0;
    
    // First, reset all rows to their original state
    rows.forEach(row => {
        // Reset display to empty string (not 'block') to respect original display value
        row.style.display = '';
    });
    
    // Then filter rows
    rows.forEach(row => {
        const itemName = row.dataset.item || '';
        const currency = row.dataset.currency || '';
        const shopName = row.dataset.shop || '';
        const stock = parseInt(row.dataset.stock) || 0;
        
        const matchesItem = !searchItem || itemName.includes(searchItem);
        const matchesCurrency = !currencyFilter || currency.includes(currencyFilter);
        const matchesShop = !shopNameFilter || shopName.includes(shopNameFilter);
        const hasStock = !hideOutOfStock || stock > 0;
        
        if (matchesItem && matchesCurrency && matchesShop && hasStock) {
            row.style.display = '';
            visibleCount++;
        } else {
            row.style.display = 'none';
        }
    });
    
    sortShops();
    updateSortHeaders();
    
    // Update matching items count
    document.getElementById('matchingItems').textContent = visibleCount;
}

function compareShopRows(a, b, column, direction) {
    const asc = direction === 'asc';
    let result = 0;

    switch (column) {
        case 'name':
            result = (a.dataset.item || '').localeCompare(b.dataset.item || '');
            break;
        case 'quantity': {
            const qtyA = parseInt(a.dataset.quantity) || 0;
            const qtyB = parseInt(b.dataset.quantity) || 0;
            result = qtyA - qtyB;
            if (result === 0) {
                result = (a.dataset.item || '').localeCompare(b.dataset.item || '');
            }
            break;
        }
        case 'currency': {
            result = (a.dataset.currency || '').localeCompare(b.dataset.currency || '');
            if (result === 0) {
                const priceA = parseInt(a.dataset.price) || 0;
                const priceB = parseInt(b.dataset.price) || 0;
                result = priceA - priceB;
                if (result === 0) {
                    result = (a.dataset.item || '').localeCompare(b.dataset.item || '');
                }
            }
            break;
        }
        case 'price': {
            const priceA = parseInt(a.dataset.price) || 0;
            const priceB = parseInt(b.dataset.price) || 0;
            if (priceA !== priceB) {
                result = priceA - priceB;
            } else {
                result = (a.dataset.currency || '').localeCompare(b.dataset.currency || '');
                if (result === 0) {
                    result = (a.dataset.item || '').localeCompare(b.dataset.item || '');
                }
            }
            break;
        }
        case 'costEach': {
            const eachA = parseFloat(a.dataset.costEach) || 0;
            const eachB = parseFloat(b.dataset.costEach) || 0;
            if (eachA !== eachB) {
                result = eachA - eachB;
            } else {
                result = (a.dataset.item || '').localeCompare(b.dataset.item || '');
            }
            break;
        }
        case 'stock': {
            const stockA = parseInt(a.dataset.stock) || 0;
            const stockB = parseInt(b.dataset.stock) || 0;
            if (stockA === 0 && stockB === 0) return 0;
            if (stockA === 0) return 1;
            if (stockB === 0) return -1;
            result = stockA - stockB;
            break;
        }
        case 'shop':
            result = (a.dataset.shop || '').localeCompare(b.dataset.shop || '');
            break;
        case 'location':
            result = (a.dataset.location || '').localeCompare(b.dataset.location || '');
            break;
        case 'distance': {
            const distA = parseFloat(a.dataset.distance) || Infinity;
            const distB = parseFloat(b.dataset.distance) || Infinity;
            result = distA - distB;
            break;
        }
        case 'relativeCost': {
            const costA = a.dataset.relativeCost;
            const costB = b.dataset.relativeCost;
            const aMissing = costA === '' || !Number.isFinite(parseFloat(costA));
            const bMissing = costB === '' || !Number.isFinite(parseFloat(costB));
            if (aMissing && bMissing) return 0;
            if (aMissing) return 1;
            if (bMissing) return -1;
            result = parseFloat(costA) - parseFloat(costB);
            if (result === 0) {
                result = (a.dataset.item || '').localeCompare(b.dataset.item || '');
            }
            break;
        }
        case 'relativeCostUnit': {
            const unitA = a.dataset.relativeUnit;
            const unitB = b.dataset.relativeUnit;
            const aMissing = unitA === '' || !Number.isFinite(parseFloat(unitA));
            const bMissing = unitB === '' || !Number.isFinite(parseFloat(unitB));
            if (aMissing && bMissing) return 0;
            if (aMissing) return 1;
            if (bMissing) return -1;
            result = parseFloat(unitA) - parseFloat(unitB);
            if (result === 0) {
                result = (a.dataset.item || '').localeCompare(b.dataset.item || '');
            }
            break;
        }
        case 'relativeValue': {
            const valA = a.dataset.relativeValue;
            const valB = b.dataset.relativeValue;
            const aMissing = valA === '' || !Number.isFinite(parseFloat(valA));
            const bMissing = valB === '' || !Number.isFinite(parseFloat(valB));
            if (aMissing && bMissing) return 0;
            if (aMissing) return 1;
            if (bMissing) return -1;
            result = parseFloat(valA) - parseFloat(valB);
            if (result === 0) {
                result = (a.dataset.item || '').localeCompare(b.dataset.item || '');
            }
            break;
        }
        case 'relativeValueUnit': {
            const unitA = a.dataset.relativeValueUnit;
            const unitB = b.dataset.relativeValueUnit;
            const aMissing = unitA === '' || !Number.isFinite(parseFloat(unitA));
            const bMissing = unitB === '' || !Number.isFinite(parseFloat(unitB));
            if (aMissing && bMissing) return 0;
            if (aMissing) return 1;
            if (bMissing) return -1;
            result = parseFloat(unitA) - parseFloat(unitB);
            if (result === 0) {
                result = (a.dataset.item || '').localeCompare(b.dataset.item || '');
            }
            break;
        }
        case 'relativeSpread': {
            const spreadA = a.dataset.relativeSpread;
            const spreadB = b.dataset.relativeSpread;
            const aMissing = spreadA === '' || !Number.isFinite(parseFloat(spreadA));
            const bMissing = spreadB === '' || !Number.isFinite(parseFloat(spreadB));
            if (aMissing && bMissing) return 0;
            if (aMissing) return 1;
            if (bMissing) return -1;
            result = parseFloat(spreadA) - parseFloat(spreadB);
            if (result === 0) {
                result = (a.dataset.item || '').localeCompare(b.dataset.item || '');
            }
            break;
        }
        default:
            return 0;
    }

    return asc ? result : -result;
}

// Sort shops
function sortShops() {
    const container = document.getElementById('shopsList');
    if (!container) return;

    const header = container.querySelector('.list-header');
    const rows = Array.from(container.querySelectorAll('.shop-row'));

    rows.sort((a, b) => compareShopRows(a, b, sortState.column, sortState.direction));

    container.innerHTML = '';
    if (header) container.appendChild(header);
    rows.forEach(row => container.appendChild(row));
}

// Delete a server
async function deleteServer(serverId) {
    if (!confirm('Are you sure you want to delete this server?')) return;
    
    const result = await window.electronAPI.deleteServer(serverId);
    if (result.success) {
        servers = result.servers;
        renderServerList();
        
        if (currentServer?.id === serverId) {
            currentServer = null;
            showNoServerState();
        }
    }
}

// Show no server state
function showNoServerState() {
    document.getElementById('noServerState').style.display = 'flex';
    document.getElementById('serverSelectedState').style.display = 'none';
}

// Refresh vending data
function refreshVendingData() {
    if (currentServer) {
        loadVendingData();
        // Filters will be reapplied automatically after data loads
    }
}

// Toggle mobile sidebar
function toggleMobileSidebar() {
    const sidebar = document.getElementById('mobileSidebar');
    sidebar.classList.toggle('mobile-open');
}

// ========== PAIRING MODAL ==========

function openPairingModal() {
    document.getElementById('pairingModal').classList.add('active');
}

function closePairingModal() {
    document.getElementById('pairingModal').classList.remove('active');
    if (isListening) {
        stopListening();
    }
}

async function startListening() {
    if (!currentCredentials) {
        alert('No credentials available. Please regenerate credentials.');
        return;
    }
    
    const startBtn = document.getElementById('startListeningBtn');
    const stopBtn = document.getElementById('stopListeningBtn');
    const pairingOutput = document.getElementById('pairingOutput');
    
    try {
        isListening = true;
        
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
        pairingOutput.style.display = 'block';
        
        pairingOutput.innerHTML = '<div style="color: #00ff88;">✓ Starting FCM listener...</div>';
        
        // Set up event listener for pairing updates
        window.electronAPI.onPairingUpdate(async (data) => {
            console.log('Pairing update received:', data);
            
            if (data.type === 'listening-started') {
                pairingOutput.innerHTML += '<div style="margin-top: 10px;">Waiting for pairing notification from Rust+ app...</div>';
            } else if (data.type === 'pairing-received') {
                pairingOutput.innerHTML += '<div style="color: #00ff88; margin-top: 20px;">✓ Server paired!</div>';
                pairingOutput.innerHTML += '<pre style="margin-top: 10px;">' + 
                    JSON.stringify(data.data, null, 2) + '</pre>';
                
                // Save the server
                const result = await window.electronAPI.saveServer(data.data);
                if (result.success) {
                    servers = result.servers;
                    renderServerList();
                    
                    setTimeout(() => {
                        closePairingModal();
                        // Select the newly added server
                        const newServer = servers.find(s => 
                            s.serverIp === data.data.serverIp && 
                            s.appPort === data.data.appPort
                        );
                        if (newServer) {
                            selectServer(newServer);
                        }
                    }, 1500);
                }
            }
        });
        
        // Start the actual FCM listener
        await window.electronAPI.startPairingListener(currentCredentials);
        
    } catch (error) {
        console.error('Error starting listener:', error);
        alert('Failed to start pairing listener: ' + error.message);
        stopListening();
    }
}

async function stopListening() {
    const startBtn = document.getElementById('startListeningBtn');
    const stopBtn = document.getElementById('stopListeningBtn');
    const pairingOutput = document.getElementById('pairingOutput');
    
    isListening = false;
    
    try {
        await window.electronAPI.stopPairingListener();
        window.electronAPI.removePairingListeners();
    } catch (error) {
        console.error('Error stopping listener:', error);
    }
    
    startBtn.style.display = 'inline-block';
    stopBtn.style.display = 'none';
    
    pairingOutput.innerHTML += '<div style="color: #ff3366; margin-top: 10px;">✗ Listening stopped</div>';
}

// ========== CREDENTIALS MODAL ==========

async function openCredentialsModal() {
    document.getElementById('credentialsModal').classList.add('active');
    
    const status = document.getElementById('credModalStatus');
    const content = document.getElementById('credModalContent');
    
    if (currentCredentials) {
        status.textContent = 'FCM Credentials Active';
        const displayCreds = {
            steamId: currentCredentials.steamId || 'Not found',
            gcm: currentCredentials.gcm ? 'Present' : 'Missing',
            fcm: currentCredentials.fcm ? 'Present' : 'Missing',
            expo: currentCredentials.expo ? 'Present' : 'Missing'
        };
        content.textContent = JSON.stringify(displayCreds, null, 2);
    } else {
        status.textContent = 'No credentials found';
        content.textContent = '';
    }
}

function closeCredentialsModal() {
    document.getElementById('credentialsModal').classList.remove('active');
}

async function deleteCredentials() {
    if (!confirm('Are you sure you want to delete your FCM credentials? You will need to regenerate them and re-pair all servers.')) {
        return;
    }
    
    try {
        await window.electronAPI.deleteCredentials();
        currentCredentials = null;
        alert('Credentials deleted. The app will now restart setup.');
        checkSetup();
    } catch (error) {
        console.error('Error deleting credentials:', error);
        alert('Failed to delete credentials');
    }
}

// ========== ITEM DATA HELPERS ==========

// Get item name from the loaded Corrosion Hour data
function getItemName(itemId) {
    const id = String(itemId);
    if (ITEM_NAMES[id]) {
        return ITEM_NAMES[id].name || ITEM_NAMES[id];
    }
    return `Unknown Item (${id})`;
}

// Get item icon name for the image URL
function getItemIcon(itemId) {
    const id = String(itemId);
    if (ITEM_NAMES[id]) {
        // Use the short name if available, otherwise convert the display name
        const item = ITEM_NAMES[id];
        const shortName = item.short || item.name;
        
        // Convert to URL-friendly format for Corrosion Hour icons
        return shortName.toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/\./g, '-')
            .replace(/[^a-z0-9-]/g, '')
            .replace(/-+/g, '-')
            .trim();
    }
    return 'scrap'; // Default icon
}

// Get item category for filtering
function getItemCategory(itemId) {
    const name = getItemName(itemId).toLowerCase();
    
    // Categorize based on item name patterns
    if (name.includes('wood') || name.includes('stone') || name.includes('metal') || 
        name.includes('sulfur') || name.includes('cloth') || name.includes('leather') ||
        name.includes('scrap') || name.includes('oil') || name.includes('fuel') ||
        name.includes('charcoal') || name.includes('bone')) {
        return 'resources';
    }
    
    if (name.includes('rifle') || name.includes('pistol') || name.includes('shotgun') ||
        name.includes('bow') || name.includes('smg') || name.includes('ak') ||
        name.includes('lr') || name.includes('mp5') || name.includes('thompson') ||
        name.includes('revolver') || name.includes('python') || name.includes('m92') ||
        name.includes('spas') || name.includes('l96')) {
        return 'weapons';
    }
    
    if (name.includes('ammo') || name.includes('bullet') || name.includes('arrow') ||
        name.includes('rocket') || name.includes('shell') || name.includes('slug')) {
        return 'ammo';
    }
    
    if (name.includes('pickaxe') || name.includes('hatchet') || name.includes('hammer') ||
        name.includes('jackhammer') || name.includes('chainsaw') || name.includes('salvaged')) {
        return 'tools';
    }
    
    if (name.includes('gear') || name.includes('spring') || name.includes('pipe') ||
        name.includes('blade') || name.includes('body') || name.includes('tech') ||
        name.includes('rope') || name.includes('tarp') || name.includes('sewing')) {
        return 'components';
    }
    
    if (name.includes('bandage') || name.includes('syringe') || name.includes('medkit') ||
        name.includes('medical')) {
        return 'medical';
    }
    
    if (name.includes('helmet') || name.includes('jacket') || name.includes('boots') ||
        name.includes('gloves') || name.includes('pants') || name.includes('hoodie') ||
        name.includes('shirt') || name.includes('armor') || name.includes('mask')) {
        return 'clothing';
    }
    
    return 'other';
}
