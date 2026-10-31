document.addEventListener('DOMContentLoaded', function() {
  const html5QrCode = new Html5Qrcode("reader");
  const resultContainer = document.getElementById("result-text");
  const apiStatus = document.getElementById("api-status");
  const actionContainer = document.getElementById("action-container");
  const userInfo = document.getElementById("user-info");
  const API_URL = window.INDIETIX_API_URL;
  let lastScannedCode = null;
  let lastCheckedStatus = null;
  let isScanning = false; // Track scanning state
  let currentAbortController = null; // For cancelling API requests
  let scanCooldownMap = new Map(); // Track cooldowns per QR code
  let scanningPaused = false; // For pausing scans without stopping camera
  
  // Sound generation
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  
  const playSound = (frequency, duration, type = 'success') => {
    const soundCheckbox = document.getElementById('sound-enabled');
    if (!soundCheckbox || !soundCheckbox.checked) return;
    
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    oscillator.frequency.value = frequency;
    oscillator.type = 'sine';
    
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration);
    
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + duration);
  };
  
  const playSuccessSound = () => {
    // Play a pleasant two-tone success sound
    playSound(600, 0.1, 'success');
    setTimeout(() => playSound(800, 0.15, 'success'), 100);
  };
  const playErrorSound = () => {
    // Two-tone error beep
    playSound(400, 0.1, 'error');
    setTimeout(() => playSound(300, 0.15, 'error'), 100);
  };
  
  // Get formatted timestamp
  const getTimestamp = () => {
    const now = new Date();
    return now.toLocaleTimeString('en-US', { hour12: false });
  };
  
  // Improved QR scanning configuration - optimized for detection speed
  const getOptimalConfig = () => {
    const screenWidth = window.innerWidth;
    
    // Responsive qrbox sizing
    let qrboxSize;
    if (screenWidth < 400) {
      qrboxSize = { width: Math.min(250, screenWidth * 0.8), height: Math.min(250, screenWidth * 0.8) };
    } else if (screenWidth < 768) {
      qrboxSize = { width: 280, height: 280 };
    } else {
      qrboxSize = { width: 300, height: 300 };
    }
    
    return {
      fps: 25, // Optimal FPS for fast, accurate detection
      qrbox: qrboxSize,
      aspectRatio: 1.0,
      disableFlip: false, // Allow flipped QR codes
      supportedScanTypes: [Html5QrcodeScanType.SCAN_TYPE_CAMERA], // Only camera scanning
      verbose: false, // Set to true for debugging
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: true // Use native barcode detection if available
      }
    };
  };
  
  // Enhanced camera configuration with fallbacks
  const getCameraConfig = async () => {
    try {
      // Try to get available cameras
      const cameras = await Html5Qrcode.getCameras();
      
      if (cameras && cameras.length > 0) {
        // Prefer back camera
        const backCamera = cameras.find(camera => 
          camera.label.toLowerCase().includes('back') || 
          camera.label.toLowerCase().includes('rear') ||
          camera.label.toLowerCase().includes('environment')
        );
        
        if (backCamera) {
          return { deviceId: backCamera.id };
        }
        
        // Fallback to last camera (usually back camera)
        return { deviceId: cameras[cameras.length - 1].id };
      }
    } catch (error) {
      console.log('Camera enumeration failed, using facingMode fallback');
    }
    
    // Fallback to facingMode
    return { facingMode: "environment" };
  };
  
  // Token checking now handled by auth-helper.js automatically
  // auth-helper will redirect to login if token is missing/expired
  
  // Display username if available
  const urlParams = new URLSearchParams(window.location.search);
  const username = urlParams.get('username');
  if (username) {
    userInfo.textContent = `Logged in as: ${username}`;
    userInfo.style.display = 'block';
  }
  
  // Add logout button
  const logoutButton = document.createElement("button");
  logoutButton.textContent = "Logout";
  logoutButton.className = "logout-button";
  logoutButton.onclick = logout;
  document.querySelector('.footer').appendChild(logoutButton);
  
  function logout() {
    // Cleanup scanner before logout
    cleanupScanner();
    
    // Use auth-helper logout for consistency
    if (window.authHelper) {
      window.authHelper.logout('Manual logout');
    } else {
      // Fallback if auth-helper not loaded
      localStorage.removeItem('authToken');
      window.location.href = 'login.html';
    }
  }
  
  // Enhanced cleanup function
  const cleanupScanner = async () => {
    try {
      if (isScanning) {
        await html5QrCode.stop();
        isScanning = false;
      }
      
      // Reset paused state
      scanningPaused = false;
      
      // Cancel any ongoing API requests
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }
      
      // Clear cooldown map to free memory
      scanCooldownMap.clear();
      
    } catch (error) {
      console.log('Cleanup error (non-critical):', error);
    }
  };
  
  // Enhanced API call with abort controller
  const makeAPICall = async (url, options = {}) => {
    // Cancel previous request if still ongoing
    if (currentAbortController) {
      currentAbortController.abort();
    }
    
    currentAbortController = new AbortController();
    
    const fetchOptions = {
      ...options,
      signal: currentAbortController.signal,
      headers: {
        ...getAuthHeaders(),
        ...options.headers
      }
    };
    
    try {
      const response = await fetch(url, fetchOptions);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('Request cancelled');
        return null;
      }
      throw error;
    } finally {
      if (currentAbortController) {
        currentAbortController = null;
      }
    }
  };
  
  // REMOVED: Duplicate health check call - now handled by auth-helper.js
  // The auth-helper will automatically update the api-status element
  
  const qrCodeSuccessCallback = async (decodedText, decodedResult) => {
    // Prevent multiple rapid scans
    if (!isScanning) return;
    
    // Check if scanning is paused (normal mode waiting for user action)
    if (scanningPaused) return;
    
    const autoCheckinCheckbox = document.getElementById('auto-checkin');
    const isAutoCheckin = autoCheckinCheckbox && autoCheckinCheckbox.checked;
    
    // IMMEDIATE DEBUG - Show in the result area what mode we're in
    console.log('=== SCAN DEBUG ===');
    console.log('Checkbox element:', autoCheckinCheckbox);
    console.log('Checkbox checked:', autoCheckinCheckbox ? autoCheckinCheckbox.checked : 'ELEMENT NOT FOUND');
    console.log('isAutoCheckin:', isAutoCheckin);
    console.log('QR Code:', decodedText);
    console.log('==================');
    
    // Also show visually on page
    if (!isAutoCheckin) {
      console.log('⚠️ NOT IN AUTO-CHECKIN MODE - will show buttons');
    } else {
      console.log('✓ IN AUTO-CHECKIN MODE - will auto check-in');
    }
    
    // Check cooldown for this specific QR code
    const now = Date.now();
    const cooldownDuration = 2000; // 2 seconds cooldown per code
    
    if (scanCooldownMap.has(decodedText)) {
      const lastScanTime = scanCooldownMap.get(decodedText);
      const timeSinceLastScan = now - lastScanTime;
      
      if (timeSinceLastScan < cooldownDuration) {
        // Still in cooldown - turn camera frame red and ignore scan
        const readerElement = document.getElementById('reader');
        if (readerElement) {
          readerElement.style.border = '4px solid #dc3545'; // Red border
          
          // Reset border color after remaining cooldown time
          const remainingCooldown = cooldownDuration - timeSinceLastScan;
          setTimeout(() => {
            readerElement.style.border = '2px solid #ddd'; // Back to normal
          }, remainingCooldown);
        }
        return; // Ignore this scan
      }
    }
    
    // Update cooldown map
    scanCooldownMap.set(decodedText, now);
    
    // Reset camera border to normal (in case it was red from previous cooldown)
    const readerElement = document.getElementById('reader');
    if (readerElement) {
      readerElement.style.border = '2px solid #ddd';
    }
    
    // Clean up old entries from cooldown map (older than 10 seconds)
    for (const [code, time] of scanCooldownMap.entries()) {
      if (now - time > 10000) {
        scanCooldownMap.delete(code);
      }
    }
    
    if (isAutoCheckin) {
      // Auto check-in mode: don't stop scanner, automatically check in
      console.log('>>> ENTERING AUTO-CHECKIN BRANCH <<<');
      lastScannedCode = decodedText;
      
      // Show scanning the code
      resultContainer.textContent = `Checking in: ${decodedText}`;
      resultContainer.style.color = "#007bff";
      
      // Perform automatic check-in
      await performAutoCheckIn(decodedText);
      
    } else {
      // Normal mode: pause scanning (but keep camera visible) and show buttons
      console.log('>>> ENTERING NORMAL MODE BRANCH <<<');
      
      // PAUSE scanning instead of stopping - camera stays visible
      scanningPaused = true;
      
      // Turn camera border red to indicate scanning is paused
      const readerElement = document.getElementById('reader');
      if (readerElement) {
        readerElement.style.border = '4px solid #dc3545'; // Red border
      }
      
      // Store the scanned code
      lastScannedCode = decodedText;
      
      // Display the result
      resultContainer.textContent = decodedText;
      resultContainer.style.color = "#007bff";
      
      // Clear any previous action buttons
      actionContainer.innerHTML = '';
      
      // Check the current status of the QR code
      checkQRCodeStatus(decodedText);
    }
  };
  
  const checkQRCodeStatus = async (qrCode) => {
    if (!qrCode) {
      displayMessage("No QR code scanned yet", "error");
      return;
    }
    
    // Show loading state
    const statusElement = document.getElementById("check-in-status") || createStatusElement();
    statusElement.textContent = "Checking QR code status...";
    statusElement.className = "status-message loading";
    
    try {
      const data = await makeAPICall(`${API_URL}/api/product_by_qrcode?search=${encodeURIComponent(qrCode)}`);
      
      // Handle cancelled request
      if (!data) return;
      
      // Hide the status message
      if (statusElement) {
        statusElement.remove();
      }
      
      // Check if we got product data
      console.log("This is the data:", JSON.stringify(data));
      if (data && data.length == 1) {
        const product = data[0];
        const isCheckedIn = product.CheckedIn || product.checkedIn || false;
        lastCheckedStatus = isCheckedIn;
        
        // Create appropriate buttons based on status
        const statusButtonGroup = document.createElement("div");
        statusButtonGroup.className = "status-button-group";
        
        if (isCheckedIn) {
          // Show Check-out button if already checked in
          const checkOutButton = document.createElement("button");
          checkOutButton.textContent = "Check-out";
          checkOutButton.className = "action-button check-out-button";
          checkOutButton.onclick = performCheckOut;
          statusButtonGroup.appendChild(checkOutButton);
          
          displayMessage("QR code is currently CHECKED IN", "success");
        } else {
          // Show Check-in button if not checked in
          const checkInButton = document.createElement("button");
          checkInButton.textContent = "Check-in";
          checkInButton.className = "action-button check-in-button";
          checkInButton.onclick = performCheckIn;
          statusButtonGroup.appendChild(checkInButton);
          
          displayMessage("QR code is currently NOT checked in", "warning");
        }
        
        actionContainer.appendChild(statusButtonGroup);
      } else {
        displayMessage("QR code not found in the system", "error");
      }
      
      // Add a restart button
      const restartButton = document.createElement("button");
      restartButton.textContent = "Scan Again";
      restartButton.className = "action-button restart-button";
      restartButton.onclick = startScanner;
      actionContainer.appendChild(restartButton);
      
    } catch (error) {
      console.error('Error checking QR code status:', error);
      displayMessage("Error: " + error.message, "error");
      
      // Add a restart button even on error
      const restartButton = document.createElement("button");
      restartButton.textContent = "Scan Again";
      restartButton.className = "action-button restart-button";
      restartButton.onclick = startScanner;
      actionContainer.appendChild(restartButton);
    }
  };
  
  const performCheckIn = async () => {
    if (!lastScannedCode) {
      displayMessage("No QR code scanned yet", "error");
      return;
    }
    
    // Show loading state
    const statusElement = document.getElementById("check-in-status") || createStatusElement();
    statusElement.textContent = "Processing check-in...";
    statusElement.className = "status-message loading";
    
    try {
      const data = await makeAPICall(`${API_URL}/api/checkin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ qrCode: lastScannedCode })
      });
      
      // Handle cancelled request
      if (!data) return;
      
      // Handle different response statuses
      switch(data.returnStatus) {
        case 'successful_checkin':
          displayMessage("Successfully checked in!", "success");
          // Unpause scanner and prepare for next scan
          setTimeout(() => {
            startScanner(); // This will unpause and reset border
          }, 1500); // Brief delay to show success message
          break;
        case 'successful_skeleton_key_checkin':
          displayMessage(`Skeleton key accepted: ${data.description || 'Access granted'}`, "success");
          // Unpause scanner and prepare for next scan
          setTimeout(() => {
            startScanner(); // This will unpause and reset border
          }, 1500); // Brief delay to show success message
          break;
        case 'failed_no_QRCode':
          displayMessage("QR code not found in the system", "error");
          break;
        case 'failed_already_checked_in':
          displayMessage("Already checked in", "warning");
          break;
        case 'failed_expired_qrcode':
          displayMessage("QR code has expired", "error");
          break;
        case 'failed_ticket_not_valid':
          displayMessage(`Ticket is not valid (${data.ticketStatus || 'not valid'})`, "error");
          break;
        case 'failed_skeleton_key_limit':
          displayMessage(data.message || "Skeleton key daily limit reached", "error");
          break;
        case 'failed_skeleton_key_rate_limit':
          displayMessage(data.message || "Skeleton key used too frequently", "error");
          break;
        default:
          displayMessage("Unknown status: " + data.returnStatus, "error");
      }
    } catch (error) {
      displayMessage("Error: " + error.message, "error");
      console.error('Check-in error:', error);
    }
  };
  
  const performAutoCheckIn = async (qrCode) => {
    console.log('performAutoCheckIn called for:', qrCode);
    
    // Clear any action buttons (shouldn't show buttons in auto-checkin mode)
    actionContainer.innerHTML = '';
    
    try {
      const data = await makeAPICall(`${API_URL}/api/checkin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ qrCode: qrCode })
      });
      
      // Handle cancelled request
      if (!data) {
        console.log('API request was cancelled');
        return;
      }
      
      console.log('Check-in API response:', data);
      
      const timestamp = getTimestamp();
      
      // Handle different response statuses
      switch(data.returnStatus) {
        case 'successful_checkin':
          resultContainer.innerHTML = `<span style="color: #28a745; font-weight: bold;">[${timestamp}] ✓ Checked in successfully</span>`;
          playSuccessSound();
          break;
        case 'successful_skeleton_key_checkin':
          resultContainer.innerHTML = `<span style="color: #28a745; font-weight: bold;">[${timestamp}] ✓ Skeleton key: ${data.description || 'Access granted'}</span>`;
          playSuccessSound();
          break;
        case 'failed_no_QRCode':
          resultContainer.innerHTML = `<span style="color: #dc3545; font-weight: bold;">[${timestamp}] ✗ QR code not found</span>`;
          playErrorSound();
          break;
        case 'failed_already_checked_in':
          resultContainer.innerHTML = `<span style="color: #dc3545; font-weight: bold;">[${timestamp}] ✗ Already checked in</span>`;
          playErrorSound();
          break;
        case 'failed_expired_qrcode':
          resultContainer.innerHTML = `<span style="color: #dc3545; font-weight: bold;">[${timestamp}] ✗ Ticket expired</span>`;
          playErrorSound();
          break;
        case 'failed_ticket_not_valid':
          resultContainer.innerHTML = `<span style="color: #dc3545; font-weight: bold;">[${timestamp}] ✗ Ticket ${data.ticketStatus || 'not valid'}</span>`;
          playErrorSound();
          break;
        case 'failed_skeleton_key_limit':
          resultContainer.innerHTML = `<span style="color: #dc3545; font-weight: bold;">[${timestamp}] ✗ ${data.message || 'Skeleton key limit reached'}</span>`;
          playErrorSound();
          break;
        case 'failed_skeleton_key_rate_limit':
          resultContainer.innerHTML = `<span style="color: #dc3545; font-weight: bold;">[${timestamp}] ✗ ${data.message || 'Skeleton key rate limit'}</span>`;
          playErrorSound();
          break;
        default:
          resultContainer.innerHTML = `<span style="color: #dc3545; font-weight: bold;">[${timestamp}] ✗ Unknown error: ${data.returnStatus}</span>`;
          playErrorSound();
      }
    } catch (error) {
      const timestamp = getTimestamp();
      resultContainer.innerHTML = `<span style="color: #dc3545; font-weight: bold;">[${timestamp}] ✗ Error: ${error.message}</span>`;
      playErrorSound();
      console.error('Auto check-in error:', error);
    }
  };
  
  const performCheckOut = async () => {
    if (!lastScannedCode) {
      displayMessage("No QR code scanned yet", "error");
      return;
    }
    
    // Show loading state
    const statusElement = document.getElementById("check-in-status") || createStatusElement();
    statusElement.textContent = "Processing check-out...";
    statusElement.className = "status-message loading";
    
    try {
      const data = await makeAPICall(`${API_URL}/api/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ qrCode: lastScannedCode })
      });
      
      // Handle cancelled request
      if (!data) return;
      
      // Handle different response statuses
      switch(data.returnStatus) {
        case 'successful_checkout':
          displayMessage("Successfully checked out!", "success");
          // Unpause scanner and prepare for next scan
          setTimeout(() => {
            startScanner(); // This will unpause and reset border
          }, 1500); // Brief delay to show success message
          break;
        case 'failed_no_QRCode':
          displayMessage("QR code not found in the system", "error");
          break;
        case 'failed_already_checked_out':
          displayMessage("Already checked out", "warning");
          break;
        case 'failed_expired_qrcode':
          displayMessage("QR code has expired", "error");
          break;
        default:
          displayMessage("Unknown status: " + data.returnStatus, "error");
      }
    } catch (error) {
      displayMessage("Error: " + error.message, "error");
      console.error('Check-out error:', error);
    }
  };
  
  const updateButtonsAfterAction = (isCheckedIn) => {
    // Clear previous action buttons
    actionContainer.innerHTML = '';
    
    // Create appropriate buttons based on status
    const statusButtonGroup = document.createElement("div");
    statusButtonGroup.className = "status-button-group";
    
    if (isCheckedIn) {
      // Show Check-out button if now checked in
      const checkOutButton = document.createElement("button");
      checkOutButton.textContent = "Check-out";
      checkOutButton.className = "action-button check-out-button";
      checkOutButton.onclick = performCheckOut;
      statusButtonGroup.appendChild(checkOutButton);
    } else {
      // Show Check-in button if now checked out
      const checkInButton = document.createElement("button");
      checkInButton.textContent = "Check-in";
      checkInButton.className = "action-button check-in-button";
      checkInButton.onclick = performCheckIn;
      statusButtonGroup.appendChild(checkInButton);
    }
    
    actionContainer.appendChild(statusButtonGroup);
    
    // Add a restart button
    const restartButton = document.createElement("button");
    restartButton.textContent = "Scan Again";
    restartButton.className = "action-button restart-button";
    restartButton.onclick = startScanner;
    actionContainer.appendChild(restartButton);
  };
  
  const displayMessage = (message, type) => {
    const statusElement = document.getElementById("check-in-status") || createStatusElement();
    statusElement.textContent = message;
    statusElement.className = "status-message " + type;
  };
  
  const createStatusElement = () => {
    const statusElement = document.createElement("div");
    statusElement.id = "check-in-status";
    statusElement.className = "status-message";
    
    // Insert it after the action container
    actionContainer.parentNode.insertBefore(statusElement, actionContainer.nextSibling);
    
    return statusElement;
  };
  
  async function startScanner() {
    // Prevent multiple simultaneous scanner starts
    if (isScanning) {
      console.log('Scanner already running - unpausing if paused');
      // Just unpause if already running
      scanningPaused = false;
      
      // Reset border to normal
      const readerElement = document.getElementById('reader');
      if (readerElement) {
        readerElement.style.border = '2px solid #ddd';
      }
      
      actionContainer.innerHTML = '';
      resultContainer.textContent = "Scanning...";
      resultContainer.style.color = "#333";
      
      // Remove status message if it exists
      const statusElement = document.getElementById("check-in-status");
      if (statusElement) {
        statusElement.remove();
      }
      return;
    }
    
    // Cleanup any existing scanner state
    await cleanupScanner();
    
    // Remove action buttons
    actionContainer.innerHTML = '';
    
    // Remove status message if it exists
    const statusElement = document.getElementById("check-in-status");
    if (statusElement) {
      statusElement.remove();
    }
    
    // Reset last scanned code and unpause
    lastScannedCode = null;
    lastCheckedStatus = null;
    scanningPaused = false;
    
    resultContainer.textContent = "Scanning...";
    resultContainer.style.color = "#333";
    
    try {
      const cameraConfig = await getCameraConfig();
      const scanConfig = getOptimalConfig();
      
      await html5QrCode.start(
        cameraConfig,
        scanConfig,
        qrCodeSuccessCallback,
        (errorMessage) => {
          // Handle errors silently to avoid console spam
          // Only log significant errors
          if (errorMessage.includes('NotFoundException') || errorMessage.includes('NotAllowedError')) {
            console.log('Camera access error:', errorMessage);
          }
        }
      );
      
      isScanning = true;
      
      // Ensure border is normal when scanner starts
      const readerElement = document.getElementById('reader');
      if (readerElement) {
        readerElement.style.border = '2px solid #ddd';
      }
      
    } catch (err) {
      console.error('Error starting camera:', err);
      resultContainer.textContent = `Error starting camera: ${err}`;
      resultContainer.style.color = "red";
      isScanning = false;
    }
  }
  
  // Cleanup on page unload
  window.addEventListener('beforeunload', cleanupScanner);
  window.addEventListener('pagehide', cleanupScanner);
  
  // Handle visibility change (e.g., tab switching)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && isScanning) {
      // Pause scanning when tab is hidden to save resources
      console.log('Tab hidden - stopping scanner to save resources');
      cleanupScanner();
    } else if (!document.hidden && !isScanning) {
      // Tab is visible again and scanner is not running - restart it
      console.log('Tab visible again - restarting scanner');
      setTimeout(() => {
        startScanner();
      }, 300); // Brief delay to ensure page is fully active
    }
  });
  
  // Start the scanner when the page loads
  startScanner();
  
  // Handle auto-checkin checkbox change - unpause if checked while paused
  const autoCheckinCheckbox = document.getElementById('auto-checkin');
  if (autoCheckinCheckbox) {
    autoCheckinCheckbox.addEventListener('change', function() {
      if (this.checked && scanningPaused) {
        console.log('Auto-checkin enabled while paused - unpausing scanner');
        startScanner(); // This will unpause and reset the border
      }
    });
  }
});
